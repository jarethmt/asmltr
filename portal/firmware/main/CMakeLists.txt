idf_component_register(SRCS "portal_main.c" "ble.c" "trust.c" "module.c" "engine.c" "usb_hid.c" "wifi_link.c"
                       INCLUDE_DIRS "."
                       REQUIRES bt nvs_flash esp_driver_spi esp_driver_rmt esp_driver_gpio esp_timer libsodium json esp_tinyusb
                                esp_wifi esp_netif esp_event lwip)
