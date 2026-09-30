FROM httpd:2.4.66-bookworm
USER 1000:1000
EXPOSE 8080
CMD ["/bin/sh", "-ec", "mkdir -p /data/content /data/locks; exec httpd -DFOREGROUND -f /config/httpd.conf"]
