// asmltr Portal — R1b UI: cyberpunk restyle. Breathing-orb idle -> tap wakes -> icon menu.
// 180deg rotation, width-safe text. Enrollment still stubbed (demo).
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_timer.h"
#include "driver/rmt_tx.h"
#include "driver/rmt_encoder.h"
#include "font8x8_basic.h"
#include "ble.h"
#include "portal_ui.h"
#include "module.h"
#include "engine.h"
#include "usb_hid.h"
#include "wifi_link.h"
#include "freertos/semphr.h"

#define PIN_LED 38
#define LED_MAX 55              // cap WS2812 brightness (full is blinding)
#define PIN_BL 48
#define PIN_MOSI 45
#define PIN_SCLK 40
#define PIN_CS 42
#define PIN_DC 41
#define PIN_RST 39
#define PIN_BOOT 0
#define LCD_W 172
#define LCD_H 320
#define X_OFF 34
#define Y_OFF 0
#define MADCTL 0xC0          // 180deg rotation (MY|MX); app-configurable later

// restrained palette: cyan primary, magenta accent, on near-black
#define C_BG     0x0000
#define C_PANEL  0x0841
#define C_CYAN   0x07FF
#define C_DIM    0x034A      // dim teal
#define C_MAG    0xF81F
#define C_VIOLET 0x801F
#define C_WHITE  0xFFFF
#define C_GREEN  0x07E6
#define C_RED    0xF800
#define C_BLUE   0x2D7F      // a bright, legible BLE blue (not pure 0x001F, which reads near-black)

static spi_device_handle_t spi;
static SemaphoreHandle_t g_ui_mux = NULL;   // serialize screen+LED between the UI loop and the engine
volatile bool g_portal_busy = false;        // true while the engine owns the screen (module running / result held)
static inline void ui_lock(void)   { if(g_ui_mux) xSemaphoreTake(g_ui_mux, portMAX_DELAY); }
static inline void ui_unlock(void) { if(g_ui_mux) xSemaphoreGive(g_ui_mux); }

// ---- activity model ----
// Any CDC rx/tx / HID / exec stamps s_last_io_us. While that stamp is recent (ACTIVITY_WINDOW_US) the
// screen is "active": the idle UI yields so a live CDC/remote panel is never painted over, and the panel
// holds for the debounce window after the LAST event instead of snapping back after each one.
#define ACTIVITY_WINDOW_US 2500000          // 2.5s debounce — panel stays up this long past the last IO
static volatile int64_t s_last_io_us = 0;
static bool s_cdc_panel_shown = false;      // is the in-place CDC panel the current view? (reset on any full redraw)

// ---- back-LED state ----
// The WS2812 shows an "ambient" color (set by the UI/engine) except during a brief data-direction flash
// (TX=magenta / RX=cyan). A decay task owns the physical LED: it shows the flash until its expiry, then
// falls back to ambient. Only the decay task calls led_rgb(), so the RMT channel has a single writer.
#define LED_FLASH_US 120000                 // a direction flash lasts ~120ms past the last event
static volatile int s_amb_r=0, s_amb_g=0, s_amb_b=0;   // ambient (resting) color
static volatile int s_act_r=0, s_act_g=0, s_act_b=0;   // active flash color
static volatile int64_t s_led_act_expiry = 0;          // flash shown until this time
static inline void led_set_ambient(int r,int g,int b){ s_amb_r=r; s_amb_g=g; s_amb_b=b; }
// The screen is "active" (held by a producer) while the engine owns it OR IO happened recently.
static inline bool screen_active(void){ return portal_ui_busy() || portal_ui_activity_active(); }
static void dc(int v){ gpio_set_level(PIN_DC,v); }
static void wrn(const uint8_t*d,int n){ spi_transaction_t t={0}; t.length=8*n; t.tx_buffer=d; spi_device_polling_transmit(spi,&t); }
static void cmd(uint8_t c){ dc(0); wrn(&c,1); }
static void d8(uint8_t v){ dc(1); wrn(&v,1); }
static void aw(int x0,int y0,int x1,int y1){
    uint8_t d[4]; int a=x0+X_OFF,b=x1+X_OFF,c=y0+Y_OFF,e=y1+Y_OFF;
    cmd(0x2A); d[0]=a>>8;d[1]=a;d[2]=b>>8;d[3]=b; dc(1); wrn(d,4);
    cmd(0x2B); d[0]=c>>8;d[1]=c;d[2]=e>>8;d[3]=e; dc(1); wrn(d,4);
    cmd(0x2C);
}
static void fill_rect(int x,int y,int w,int h,uint16_t col){
    if(x<0){ w+=x; x=0; }
    if(y<0){ h+=y; y=0; }
    if(x+w>LCD_W){ w=LCD_W-x; }
    if(y+h>LCD_H){ h=LCD_H-y; }
    if(w<=0||h<=0){ return; }
    aw(x,y,x+w-1,y+h-1);
    static uint8_t line[LCD_W*2];
    for(int i=0;i<w;i++){ line[2*i]=col>>8; line[2*i+1]=col; }
    dc(1); for(int r=0;r<h;r++) wrn(line,w*2);
}
static void clear(uint16_t col){ fill_rect(0,0,LCD_W,LCD_H,col); }

// ---- color math ----
static uint16_t scale565(uint16_t c,int in){ // in 0..256
    int r=(c>>11)&0x1f,g=(c>>5)&0x3f,b=c&0x1f;
    r=r*in>>8; g=g*in>>8; b=b*in>>8; return (r<<11)|(g<<5)|b;
}
static uint16_t lerp565(uint16_t a,uint16_t b,int t){ // t 0..256
    int ar=(a>>11)&0x1f,ag=(a>>5)&0x3f,ab=a&0x1f, br=(b>>11)&0x1f,bg=(b>>5)&0x3f,bb=b&0x1f;
    return (((ar+((br-ar)*t>>8))<<11)|((ag+((bg-ag)*t>>8))<<5)|(ab+((bb-ab)*t>>8)));
}

// ---- WS2812 status LED (GPIO38, RMT) ----
static rmt_channel_handle_t s_led=NULL; static rmt_encoder_handle_t s_enc=NULL;
static void led_init(void){
    rmt_tx_channel_config_t ch={ .gpio_num=PIN_LED,.clk_src=RMT_CLK_SRC_DEFAULT,
        .resolution_hz=10000000,.mem_block_symbols=64,.trans_queue_depth=4 };
    if(rmt_new_tx_channel(&ch,&s_led)!=ESP_OK) return;
    rmt_bytes_encoder_config_t be={
        .bit0={ .level0=1,.duration0=3,.level1=0,.duration1=9 },
        .bit1={ .level0=1,.duration0=9,.level1=0,.duration1=3 },
        .flags.msb_first=1 };
    rmt_new_bytes_encoder(&be,&s_enc);
    rmt_enable(s_led);
}
static void led_rgb(int r,int g,int b){           // 0..255, auto-dimmed to LED_MAX
    if(!s_led||!s_enc) return;
    uint8_t grb[3]={ (uint8_t)(g*LED_MAX/255),(uint8_t)(r*LED_MAX/255),(uint8_t)(b*LED_MAX/255) };
    rmt_transmit_config_t tx={ .loop_count=0 };
    rmt_transmit(s_led,s_enc,grb,3,&tx); rmt_tx_wait_all_done(s_led,50);
}

// ---- width-safe text ----
static void draw_char(int x,int y,char ch,int s,uint16_t fg,uint16_t bg){
    unsigned uc=(unsigned char)ch; if(uc>127) uc='?'; if(s<1)s=1; if(s>3)s=3;
    int W=8*s,H=8*s; if(x>=LCD_W||y>=LCD_H) return;
    static uint8_t buf[24*24*2];
    for(int row=0;row<8;row++){ uint8_t bits=font8x8_basic[uc][row];
        for(int sy=0;sy<s;sy++){ int py=row*s+sy;
            for(int col=0;col<8;col++){ uint16_t c=((bits>>col)&1)?fg:bg;
                for(int sx=0;sx<s;sx++){ int px=col*s+sx,idx=(py*W+px)*2; buf[idx]=c>>8; buf[idx+1]=c; } } } }
    if(x+W>LCD_W||y+H>LCD_H) return; // skip if would overflow (caller keeps in-bounds)
    aw(x,y,x+W-1,y+H-1); dc(1); wrn(buf,W*H*2);
}
static int tw(const char*s,int sc){ return (int)strlen(s)*8*sc; }
static void draw_text(int x,int y,const char*str,int s,uint16_t fg,uint16_t bg){
    int cx=x; for(const char*p=str;*p;p++){ if(cx+8*s>LCD_W) break; draw_char(cx,y,*p,s,fg,bg); cx+=8*s; }
}
static void draw_center(int y,const char*str,int s,uint16_t fg,uint16_t bg){
    int w=tw(str,s); if(w>LCD_W){ s=1; w=tw(str,s);} draw_text((LCD_W-w)/2,y,str,s,fg,bg);
}

// ---- geometry ----
static void tri(int cx,int y,int half,int h,int up,uint16_t col){
    for(int i=0;i<h;i++){ int ww=up?(half*2*(i+1)/h):(half*2*(h-i)/h); fill_rect(cx-ww/2,y+i,ww,1,col); }
}
static void brackets(int x,int y,int w,int h,uint16_t col){ int L=10,t=2;
    fill_rect(x,y,L,t,col);fill_rect(x,y,t,L,col); fill_rect(x+w-L,y,L,t,col);fill_rect(x+w-t,y,t,L,col);
    fill_rect(x,y+h-t,L,t,col);fill_rect(x,y+h-L,t,L,col); fill_rect(x+w-L,y+h-t,L,t,col);fill_rect(x+w-t,y+h-L,t,L,col);
}
static void icon_install(int cx,int iy,uint16_t c){ fill_rect(cx-3,iy,6,18,c); tri(cx,iy+16,9,10,0,c); fill_rect(cx-16,iy+32,32,4,c); }
static void icon_uninstall(int cx,int iy,uint16_t c){ tri(cx,iy+4,9,10,1,c); fill_rect(cx-3,iy+14,6,18,c); fill_rect(cx-16,iy+36,32,4,c); }
static void icon_status(int cx,int iy,uint16_t c){ fill_rect(cx-15,iy+22,8,14,c); fill_rect(cx-4,iy+12,8,24,c); fill_rect(cx+7,iy+2,8,34,c); }

// ---- breathing orb (idle) ----
static void draw_orb(int cx,int cy,int R,float breath){
    aw(cx-R,cy-R,cx+R,cy+R); dc(1);
    static uint8_t line[2*(2*70+1)];
    int W=2*R+1;
    for(int yy=-R;yy<=R;yy++){
        for(int xx=-R;xx<=R;xx++){
            float d=sqrtf((float)(xx*xx+yy*yy))/R; uint16_t c=C_BG;
            if(d<=1.0f){ int t=(int)(d*256); uint16_t base=lerp565(0xDFFF,C_VIOLET,t);
                float f=(1.0f-d); int in=(int)(256*f*f*breath); if(in>256)in=256; c=scale565(base,in); }
            int i=(xx+R)*2; line[i]=c>>8; line[i+1]=c;
        }
        wrn(line,W*2);
    }
}

static void st7789_init(void){
    gpio_set_direction(PIN_DC,GPIO_MODE_OUTPUT); gpio_set_direction(PIN_RST,GPIO_MODE_OUTPUT);
    gpio_set_level(PIN_RST,0); vTaskDelay(pdMS_TO_TICKS(50)); gpio_set_level(PIN_RST,1); vTaskDelay(pdMS_TO_TICKS(150));
    cmd(0x11); vTaskDelay(pdMS_TO_TICKS(120));
    cmd(0x3A); d8(0x55); cmd(0x36); d8(MADCTL); cmd(0x21); cmd(0x13);
    cmd(0x29); vTaskDelay(pdMS_TO_TICKS(50));
}

// ---- button: 0 none, 1 tap, 2 hold ----
static int poll_button(void){
    static int prev=1; int cur=gpio_get_level(PIN_BOOT);
    if(prev==1&&cur==0){ int64_t t0=esp_timer_get_time(); vTaskDelay(pdMS_TO_TICKS(30));
        while(gpio_get_level(PIN_BOOT)==0) vTaskDelay(pdMS_TO_TICKS(10));
        prev=1; return ((esp_timer_get_time()-t0)/1000)>=600?2:1; }
    prev=cur; return 0;
}
static void wait_press(void){ while(poll_button()==0) vTaskDelay(pdMS_TO_TICKS(15)); }

// Menu actions. Labels indexed by action code (ACT_* == LBL slot), so the same array serves both.
enum { ACT_INSTALL=0, ACT_REMOVE=1, ACT_STATUS=2 };
static const char* LBL[3]={"INSTALL","REMOVE","STATUS"};

// Does the detected host OS have a known installer recipe? Only Windows does for now (extend the
// matched set as more OSes get recipes). "connected"/unknown/"—"/no-host → false. Re-read live.
static bool host_has_installer(void){ return strcmp(usb_host_os(),"Windows")==0; }

// Build the live menu action list; returns the count. Install/Remove appear ONLY when the host has an
// installer — otherwise just Status, so the menu can never select an install that can't run.
static int menu_items(int *acts){
    int n=0;
    if(host_has_installer()){ acts[n++]=ACT_INSTALL; acts[n++]=ACT_REMOVE; }
    acts[n++]=ACT_STATUS;
    return n;
}

// Vertical slot for item i of n. 3 items keep the established layout (don't disturb the resting view);
// fewer items center vertically so a Status-only menu isn't stranded at the top.
static int menu_item_y(int i,int n){
    static const int YS3[3]={44,140,236};
    if(n>=3) return YS3[i<3?i:2];
    if(n==2) return (i==0)?92:188;
    return 140;
}

static void draw_menu(int sel){
    int acts[3]; int n=menu_items(acts);
    if(sel>=n) sel=0;
    ui_lock();
    clear(C_BG);
    s_cdc_panel_shown=false;   // full redraw — the CDC panel is no longer on screen
    draw_center(10,"asmltr portal",2,C_DIM,C_BG);
    for(int i=0;i<n;i++){ int y=menu_item_y(i,n); uint16_t c=(i==sel)?C_MAG:C_DIM;
        int a=acts[i];
        if(a==ACT_INSTALL) icon_install(LCD_W/2,y,c); else if(a==ACT_REMOVE) icon_uninstall(LCD_W/2,y,c); else icon_status(LCD_W/2,y,c);
        draw_center(y+46,LBL[a],2,(i==sel)?C_WHITE:C_DIM,C_BG);
        if(i==sel) brackets(LCD_W/2-44,y-8,88,70,C_MAG);
    }
    // No installer recipe for this host → say WHY install/remove aren't offered.
    if(!host_has_installer()){
        char hl[40]; snprintf(hl,sizeof hl,"host: %s - no installer",usb_host_os());
        draw_center(LCD_H-32,hl,1,C_DIM,C_BG);
    }
    draw_center(LCD_H-16,"tap / hold",1,C_DIM,C_BG);
    led_set_ambient(0,70,90);   // menu: steady dim cyan
    ui_unlock();
}
// The holding page: a full-screen breathing orb, shown ONLY while the phone is disconnected. Returns
// true if a button tap woke us (caller shows the menu), false if it yielded to activity or a connect.
static bool idle_screensaver(void){
    if(screen_active()) return false;
    // Full clear on entry so nothing from a prior CDC/remote panel shows behind the orb.
    ui_lock(); clear(C_BG); s_cdc_panel_shown=false; ui_unlock();
    float t=0;
    while(1){
        if(poll_button()) return true;
        if(screen_active()) return false;      // CDC/remote panel owns the screen — hold it, don't paint
        if(ble_is_connected()) return false;   // phone connected — resting view becomes the menu
        float breath=0.30f+0.70f*(0.5f+0.5f*sinf(t*1.7f));
        led_set_ambient((int)(90*breath),(int)(200*breath),(int)(255*breath));
        ui_lock();
        if(!screen_active()){                  // re-check inside the lock — no check-then-draw race
            draw_orb(LCD_W/2,150,66,breath);
            draw_center(236,"asmltr portal",2,scale565(C_CYAN,(int)(120+120*breath)),C_BG);
            char hostline[32]; snprintf(hostline,sizeof hostline,"host: %s",usb_host_os());
            draw_center(262,hostline,1,C_DIM,C_BG);
            draw_center(LCD_H-20,"tap to wake",1,C_DIM,C_BG);
        }
        ui_unlock();
        t+=0.18f; vTaskDelay(pdMS_TO_TICKS(45));
    }
}
static void progress(const char*step,int pct){
    fill_rect(0,150,LCD_W,56,C_BG);
    draw_center(150,step,1,C_CYAN,C_BG);
    fill_rect(20,172,LCD_W-40,10,C_PANEL);
    fill_rect(21,173,(LCD_W-42)*pct/100,8,C_MAG);
    char b[8]; snprintf(b,sizeof(b),"%d%%",pct); draw_center(190,b,1,C_WHITE,C_BG);
}
static void run_action(int install){
    clear(C_BG);
    s_cdc_panel_shown=false;
    draw_center(20, install?"INSTALLING":"REMOVING",2,C_CYAN,C_BG);
    const char* IN[]={"Detecting host","Acquiring network","Joining Pangolin","Installing agent","Registering node","Phoning home"};
    const char* UN[]={"Detecting host","Deregistering","Removing agent","Leaving Pangolin","Cleaning up","Confirming"};
    const char** S=install?IN:UN;
    for(int i=0;i<6;i++){
        progress(S[i],(i+1)*100/6);
        led_set_ambient(255,0,120);                 // working: magenta
        vTaskDelay(pdMS_TO_TICKS(325));
        led_set_ambient(120,0,60); vTaskDelay(pdMS_TO_TICKS(325));  // pulse
    }
    led_set_ambient(0,255,40);                      // done: green
    clear(C_BG);
    // big check
    for(int i=0;i<12;i++) fill_rect(LCD_W/2-18+i,130+i,5,5,C_GREEN);
    for(int i=0;i<26;i++) fill_rect(LCD_W/2-6+i,142-i,5,5,C_GREEN);
    draw_center(190, install?"AGENT IS IN":"REMOVED",2,C_GREEN,C_BG);
    draw_center(220,"demo - no host yet",1,C_DIM,C_BG);
    draw_center(LCD_H-20,"press to continue",1,C_DIM,C_BG);
    wait_press();
}
static void show_status(void){
    clear(C_BG);
    s_cdc_panel_shown=false;
    led_set_ambient(0,180,220);   // status: cyan
    draw_center(20,"STATUS",2,C_CYAN,C_BG);
    const char* L[]={"board  Waveshare 1.47","screen ST7789 OK","backbone Pangolin TBD","agent  not enrolled","link   none"};
    for(int i=0;i<5;i++) draw_text(12,70+i*22,L[i],1,(i<2)?C_WHITE:C_DIM,C_BG);
    draw_center(LCD_H-20,"press to continue",1,C_DIM,C_BG);
    wait_press();
}

// ---- readable display toolkit (word-wrap + named icons) for the module engine ----------------
// This is a 172x320 screen — small. Body text is size 2 (16px), headlines size 3 (24px), and
// everything word-wraps to the width so nothing runs off the edge.
#define RGB565(r,g,b) ((uint16_t)((((r)&0xf8)<<8)|(((g)&0xfc)<<3)|((b)>>3)))

// Word-wrap `str` and draw it centered from y down; returns the y below the last line.
static int draw_center_wrapped(int y,const char*str,int size,uint16_t fg,uint16_t bg){
    if(!str||!*str) return y;
    int cw=8*size, maxch=(LCD_W-8)/cw; if(maxch<1) maxch=1;
    char line[40];
    const char*p=str;
    while(*p){
        while(*p==' ') p++;
        if(!*p) break;
        int len=0, lastspace=-1; const char*q=p;
        while(*q && len<maxch && len<(int)sizeof(line)-1){ if(*q==' ') lastspace=len; line[len++]=*q; q++; }
        if(*q && *q!=' ' && lastspace>0){ len=lastspace; q=p+lastspace; }   // back up to word boundary
        while(len>0 && line[len-1]==' ') len--;
        line[len]='\0';
        draw_center(y,line,size,fg,bg);
        y += 8*size + 4;
        p=q;
    }
    return y;
}

// ---- tiny icon set (drawn, accent-colored) -----------------------------------
static void draw_disc(int cx,int cy,int rad,uint16_t c){
    for(int yy=-rad;yy<=rad;yy++){ int xx=(int)(sqrtf((float)(rad*rad-yy*yy))); fill_rect(cx-xx,cy+yy,2*xx+1,1,c); }
}
static void draw_ring(int cx,int cy,int rad,int th,uint16_t c){
    for(int yy=-rad;yy<=rad;yy++) for(int xx=-rad;xx<=rad;xx++){ int d2=xx*xx+yy*yy; if(d2<=rad*rad && d2>=(rad-th)*(rad-th)) fill_rect(cx+xx,cy+yy,1,1,c); }
}
static void draw_named_icon(int cx,int cy,const char*name,uint16_t c){
    if(!name||!*name){ return; }
    if(!strcmp(name,"check")){ for(int i=0;i<10;i++) fill_rect(cx-12+i,cy+i,5,5,c); for(int i=0;i<22;i++) fill_rect(cx-2+i,cy+8-i,5,5,c); }
    else if(!strcmp(name,"cross")){ for(int i=-14;i<=14;i++){ fill_rect(cx+i-2,cy+i-2,5,5,c); fill_rect(cx+i-2,cy-i-2,5,5,c); } }
    else if(!strcmp(name,"lock")){ draw_ring(cx,cy-10,10,4,c); fill_rect(cx-14,cy-2,28,22,c); fill_rect(cx-3,cy+5,6,8,C_BG); }
    else if(!strcmp(name,"bolt")){ for(int i=0;i<16;i++) fill_rect(cx-2-i/2,cy-18+i,6,2,c); for(int i=0;i<16;i++) fill_rect(cx-6+i/2,cy+i,6,2,c); }
    else if(!strcmp(name,"info")){ draw_ring(cx,cy,18,3,c); fill_rect(cx-2,cy-9,5,5,c); fill_rect(cx-2,cy-1,5,12,c); }
    else if(!strcmp(name,"link")){ draw_ring(cx-9,cy,11,4,c); draw_ring(cx+9,cy,11,4,c); }
    else if(!strcmp(name,"portal")){ draw_disc(cx,cy,18,scale565(c,120)); draw_ring(cx,cy,18,3,c); draw_disc(cx,cy,5,c); }
    else { draw_disc(cx,cy,9,c); }   // "dot" / unknown
}

// ---- actuator surface for the module engine (portal_ui.h) --------------------
// Bus-safe wrappers around the draw/LED primitives. The engine calls these; the idle UI loop
// yields the screen while g_portal_busy is set (portal_ui_set_busy).
void portal_ui_led(int r,int g,int b){ led_set_ambient(r,g,b); }   // sets the resting color; the decay task drives the pin
// A module "frame": optional accent icon on top, a big wrapped title, and a wrapped body below it.
void portal_ui_screen(const char *icon,const char *title,const char *body,int r,int g,int b){
    if(g_ui_mux) xSemaphoreTake(g_ui_mux,portMAX_DELAY);
    uint16_t accent = RGB565(r,g,b);
    clear(C_BG);
    s_cdc_panel_shown=false;   // full-screen frame — CDC panel no longer owns the screen
    int y=18;
    if(icon && *icon){ draw_named_icon(LCD_W/2,y+22,icon,accent); y+=62; }
    if(title && *title){ int ts=(strlen(title)<=6)?3:2; y=draw_center_wrapped(y,title,ts,accent,C_BG)+8; }
    if(body && *body){ draw_center_wrapped(y+6,body,2,C_WHITE,C_BG); }
    if(g_ui_mux) xSemaphoreGive(g_ui_mux);
}
void portal_ui_progress(const char *label,int pct){
    if(pct<0) pct=0;
    if(pct>100) pct=100;
    if(g_ui_mux) xSemaphoreTake(g_ui_mux,portMAX_DELAY);
    clear(C_BG);
    s_cdc_panel_shown=false;
    draw_center_wrapped(70,label&&*label?label:"working",2,C_CYAN,C_BG);
    int bx=18,bw=LCD_W-36,by=168,bh=18;
    fill_rect(bx,by,bw,bh,C_PANEL);
    fill_rect(bx+2,by+2,(bw-4)*pct/100,bh-4,C_MAG);
    char p[8]; snprintf(p,sizeof p,"%d%%",pct);
    draw_center(by+30,p,2,C_WHITE,C_BG);
    if(g_ui_mux) xSemaphoreGive(g_ui_mux);
}
void portal_ui_set_busy(bool busy){ g_portal_busy = busy; }
bool portal_ui_busy(void){ return g_portal_busy; }

// ---- activity model + data-direction LED ------------------------------------
void portal_ui_mark_activity(void){ s_last_io_us = esp_timer_get_time(); }
bool portal_ui_activity_active(void){ return (esp_timer_get_time() - s_last_io_us) < ACTIVITY_WINDOW_US; }

static void led_flash(int r,int g,int b){      // show a direction flash, extend its decay, mark activity
    s_act_r=r; s_act_g=g; s_act_b=b;
    int64_t now=esp_timer_get_time();
    s_led_act_expiry = now + LED_FLASH_US;
    s_last_io_us = now;
}
void portal_ui_tx_flash(void){ led_flash(236, 72,153); }   // dongle -> host: magenta
void portal_ui_rx_flash(void){ led_flash( 34,211,238); }   // host -> dongle: cyan

// The LED decay task is the ONLY writer of the physical WS2812: flash color until its expiry, else the
// ambient color the UI/engine last set. ~20ms tick is well under the 120ms flash so the pin never lags.
static void led_task(void *arg){
    for(;;){
        if(esp_timer_get_time() < s_led_act_expiry) led_rgb(s_act_r, s_act_g, s_act_b);
        else                                        led_rgb(s_amb_r, s_amb_g, s_amb_b);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

// In-place CDC/host-output panel: draw chrome once on entry, then update only the text region per line
// so a stream of output updates WITHOUT a full-screen clear (which is what strobed between frames).
void portal_ui_cdc_line(const char *line){
    if(!line) return;
    ui_lock();
    if(!s_cdc_panel_shown){
        clear(C_BG);
        draw_named_icon(LCD_W/2, 44, "link", C_CYAN);
        draw_center(84, "HOST", 2, C_CYAN, C_BG);
        s_cdc_panel_shown = true;
    }
    fill_rect(0, 128, LCD_W, 120, C_BG);                 // clear just the body band — no full-screen clear
    draw_center_wrapped(132, line, 2, C_WHITE, C_BG);
    ui_unlock();
}

// Persistent link-status dot, top-right corner: a soft "glow" halo + bright core, re-stamped on top of
// whatever's on screen. RED = no phone connected, BLUE = connected over BLE, GREEN = Wi-Fi P2P fast path.
static void status_dot_task(void *arg){
    const int x = LCD_W - 15, y = 6, sz = 11;
    for(;;){
        uint16_t col = wifi_link_active() ? C_GREEN : (ble_is_connected() ? C_BLUE : C_RED);
        ui_lock();
        fill_rect(x-3, y-3, sz+6, sz+6, scale565(col, 45));   // soft halo = the glow
        fill_rect(x,   y,   sz,   sz,   col);                 // bright core
        ui_unlock();
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

// Interactive icon menu. Returns when the screen must change hands: activity starts (a CDC/remote panel
// wants the screen), the BLE link state flips (so the resting view must switch orb<->menu), or — when
// `timeout` is set (we were woken from the orb, not resting here) — 25s of no input elapses.
static void run_menu(int *sel, bool timeout){
    int acts[3]; int n=menu_items(acts);
    if(*sel>=n) *sel=0;
    draw_menu(*sel);
    bool conn0 = ble_is_connected();
    bool hi0   = host_has_installer();
    int64_t last = esp_timer_get_time();
    while(1){
        if(screen_active()) return;
        if(ble_is_connected() != conn0) return;
        if(host_has_installer() != hi0) return;   // host OS gained/lost an installer → rebuild the menu
        n=menu_items(acts);
        if(*sel>=n) *sel=0;                        // never leave sel on a now-hidden item
        int ev=poll_button();
        if(ev==1){ *sel=(*sel+1)%n; draw_menu(*sel); last=esp_timer_get_time(); }
        else if(ev==2){
            int a=acts[*sel];
            if(a==ACT_INSTALL) run_action(1); else if(a==ACT_REMOVE) run_action(0); else show_status();
            draw_menu(*sel); last=esp_timer_get_time();
        }
        if(timeout && (esp_timer_get_time()-last)/1000000 > 25) return;
        vTaskDelay(pdMS_TO_TICKS(15));
    }
}

void app_main(void){
    printf("\n==== asmltr Portal UI (R1b) ====\n");
    usb_hid_init();   // R4a: composite USB HID+CDC — console moves to CDC from here on
    g_ui_mux = xSemaphoreCreateMutex();
    gpio_reset_pin(PIN_BOOT); gpio_set_direction(PIN_BOOT,GPIO_MODE_INPUT); gpio_set_pull_mode(PIN_BOOT,GPIO_PULLUP_ONLY);
    gpio_reset_pin(PIN_BL); gpio_set_direction(PIN_BL,GPIO_MODE_OUTPUT); gpio_set_level(PIN_BL,1);
    spi_bus_config_t bus={ .mosi_io_num=PIN_MOSI,.miso_io_num=-1,.sclk_io_num=PIN_SCLK,.quadwp_io_num=-1,.quadhd_io_num=-1,.max_transfer_sz=LCD_W*LCD_H*2+16 };
    spi_bus_initialize(SPI2_HOST,&bus,SPI_DMA_CH_AUTO);
    spi_device_interface_config_t dev={ .clock_speed_hz=40*1000*1000,.mode=0,.spics_io_num=PIN_CS,.queue_size=7 };
    spi_bus_add_device(SPI2_HOST,&dev,&spi);
    st7789_init();
    led_init();
    ble_init();   // R3: BLE control link — advertise + GATT
    module_init();   // libsodium + the chunked signed-module loader
    engine_init();   // the step-DSL loader engine (its own task)
    xTaskCreate(status_dot_task, "portal-dot", 2560, NULL, 3, NULL);   // persistent link-status glow
    xTaskCreate(led_task, "portal-led", 2048, NULL, 3, NULL);           // sole writer of the WS2812 (ambient + flashes)

    int sel=0;
    while(1){
        // While a producer owns the screen — a held module/completion frame (busy) OR a live CDC/remote
        // panel (recent activity) — the UI draws NOTHING, so it can never paint over it. A tap dismisses.
        if(screen_active()){
            if(poll_button()){ portal_ui_set_busy(false); s_last_io_us=0; s_led_act_expiry=0; }
            vTaskDelay(pdMS_TO_TICKS(40));
            continue;
        }
        if(ble_is_connected()){
            run_menu(&sel, false);          // phone connected: the menu IS the resting view
        } else {
            bool woke = idle_screensaver();  // phone disconnected: full-screen breathing holding page
            if(woke && !screen_active() && !ble_is_connected())
                run_menu(&sel, true);        // a tap on the orb wakes the menu for 25s, then back to orb
        }
    }
}
