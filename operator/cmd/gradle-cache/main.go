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

	"github.com/expbuild/expbuild/operator/internal/gradlecache"
)

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	data := flag.String("data", "/data/cache", "persistent cache directory")
	credentials := flag.String("credentials", "/auth/htpasswd", "single-user bcrypt htpasswd file")
	maxEntry := flag.Int64("max-entry-bytes", 1<<30, "maximum archive size")
	maxTotal := flag.Int64("max-total-bytes", 16<<30, "cache eviction budget")
	flag.Parse()
	cache, err := gradlecache.New(*data, *credentials, *maxEntry, *maxTotal)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *listen, Handler: cache, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
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
