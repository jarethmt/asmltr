idf_component_register(
    SRCS
        "src/esp_olm.c"
        "src/olm_crypto.c"
        "src/olm_http.c"
        "src/olm_ws.c"
        "src/olm_proto.c"
        "src/olm_wg.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src"
    REQUIRES
        esp_wireguard
    PRIV_REQUIRES
        json
        mbedtls
        esp-tls
        esp_http_client
        esp_websocket_client
        zlib
        nvs_flash
        esp_wifi
        lwip
        esp_timer
)
