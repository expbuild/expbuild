package main

import (
	"context"
	"flag"
	"net"
	"os"

	"github.com/expbuild/expbuild/pkg/ac"
	"github.com/expbuild/expbuild/pkg/cas"
	"github.com/expbuild/expbuild/pkg/cas/store"
	"github.com/expbuild/expbuild/pkg/config"
	"github.com/expbuild/expbuild/pkg/exe"
	"github.com/expbuild/expbuild/pkg/log"
	pbbs "github.com/expbuild/expbuild/pkg/proto/gen/bytestream"
	pb "github.com/expbuild/expbuild/pkg/proto/gen/remote_execution"
	"google.golang.org/grpc"
)

// Version indicates the current version of the application.
var Version = "1.0.0"

var flagConfig = flag.String("config", "./config/local.yml", "path to the config file")

func main() {
	flag.Parse()

	logger := log.New().With(context.Background(), "version", Version)

	// load application configurations
	cfg, err := config.Load(*flagConfig, logger)
	if err != nil {
		logger.Errorf("failed to load application configuration: %s", err)
		os.Exit(-1)
	}

	lis, err := net.Listen("tcp", cfg.ServerHost)
	if err != nil {
		logger.Errorf("failed to listen: %v", err)
		return
	}
	s := grpc.NewServer()
	exe_svr, err := exe.MakeExeServer()
	if err != nil {
		logger.Errorf("exe server init error %v", err)
		panic(1)
	}

	cas_svr := cas.CASService{
		Store: store.MakeRedisStore(),
	}

	ac_svr := ac.NewActionCache()

	pb.RegisterContentAddressableStorageServer(s, &cas_svr)
	pbbs.RegisterByteStreamServer(s, &cas_svr)
	pb.RegisterExecutionServer(s, exe_svr)
	pb.RegisterActionCacheServer(s, ac_svr)

	exe_svr.Start()

	logger.Infof("server listening at %v", lis.Addr())
	if err := s.Serve(lis); err != nil {
		logger.Errorf("failed to serve: %v", err)
	}
}
