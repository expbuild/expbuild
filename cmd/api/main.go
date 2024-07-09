package main

import (
	"context"
	"flag"
	"os"

	"github.com/expbuild/expbuild/pkg/api"
	"github.com/expbuild/expbuild/pkg/cache"
	"github.com/expbuild/expbuild/pkg/config"
	"github.com/expbuild/expbuild/pkg/database"
	"github.com/expbuild/expbuild/pkg/log"
	"github.com/gin-gonic/gin"
)

// @title           Swagger Example API
// @version         1.0
// @description     This is a sample server celler server.
// @termsOfService  http://swagger.io/terms/

// @contact.name   API Support
// @contact.url    http://www.swagger.io/support
// @contact.email  support@swagger.io

// @license.name  Apache 2.0
// @license.url   http://www.apache.org/licenses/LICENSE-2.0.html

// @host      localhost:8001
// @BasePath  /api/v1

// @securityDefinitions.apikey JwtAuth
// @in header
// @name Authorization

// @securityDefinitions.apikey ApiKeyAuth
// @in header
// @name X-API-Key

// @externalDocs.description  OpenAPI
// @externalDocs.url          https://swagger.io/resources/open-api/
var Version = "1.0.0"

var flagConfig = flag.String("config", "./config/local.yml", "path to the config file")

func main() {
	logger := log.New().With(context.Background(), "version", Version)

	cfg, err := config.Load(*flagConfig, logger)
	if err != nil {
		logger.Errorf("failed to load application configuration: %s", err)
		os.Exit(-1)
	}
	cache.InitRedis()
	database.ConnectDatabase(cfg.DSN)

	//gin.SetMode(gin.ReleaseMode)
	gin.SetMode(gin.DebugMode)

	r := api.InitRouter()

	if err := r.Run(":8001"); err != nil {
		logger.Errorf("failed to bind : %s", err)
	}
}
