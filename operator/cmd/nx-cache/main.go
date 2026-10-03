package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/expbuild/expbuild/operator/internal/nxcache"
)

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	data := flag.String("data", "/data/cache", "persistent cache directory")
	credentials := flag.String("credentials", "/auth/htpasswd", "cache and health bcrypt htpasswd file")
	maxEntry := flag.Int64("max-entry-bytes", 256<<20, "maximum archive size")
	maxTotal := flag.Int64("max-total-bytes", 16<<30, "cache eviction budget")
	namespace := flag.String("namespace", "", "required instance ID scope")
	flag.Parse()
	cache, err := nxcache.New(*data, *credentials, *namespace, *maxEntry, *maxTotal)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *listen, Handler: cache, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, ReadTimeout: 5 * time.Minute, WriteTimeout: 5 * time.Minute, MaxHeaderBytes: 16 << 10}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
