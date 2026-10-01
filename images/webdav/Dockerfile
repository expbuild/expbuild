FROM httpd:2.4.68-trixie@sha256:03f858efb82c25cb0f9962946615cdcdaf26927cb971722149b563197cfd0fdd
USER 1000:1000
EXPOSE 8080
CMD ["/bin/sh", "-ec", "mkdir -p /data/content /data/locks; exec httpd -DFOREGROUND -f /config/httpd.conf"]
