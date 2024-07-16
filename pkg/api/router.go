package api

import (
	"time"

	"github.com/expbuild/expbuild/pkg/auth"
	"github.com/expbuild/expbuild/pkg/middleware"

	"github.com/expbuild/expbuild/pkg/api/books"
	"github.com/expbuild/expbuild/pkg/api/instances"
	"github.com/expbuild/expbuild/pkg/docs"

	"github.com/gin-gonic/gin"
	swaggerfiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	"golang.org/x/time/rate"
)

func InitRouter() *gin.Engine {
	r := gin.Default()

	r.Use(gin.Logger())
	if gin.Mode() == gin.ReleaseMode {
		r.Use(middleware.Security())
		r.Use(middleware.Xss())
	}
	r.Use(middleware.Cors())
	r.Use(middleware.RateLimiter(rate.Every(1*time.Minute), 60)) // 60 requests per minute

	docs.SwaggerInfo.BasePath = "/api/v1"
	v1 := r.Group("/api/v1")
	{
		v1.GET("/", books.Healthcheck)
		v1.GET("/books", middleware.APIKeyAuth(), books.FindBooks)
		v1.POST("/books", middleware.APIKeyAuth(), middleware.JWTAuth(), books.CreateBook)
		v1.GET("/books/:id", middleware.APIKeyAuth(), books.FindBook)
		v1.PUT("/books/:id", middleware.APIKeyAuth(), books.UpdateBook)
		v1.DELETE("/books/:id", middleware.APIKeyAuth(), books.DeleteBook)

		v1.GET("/instances", middleware.APIKeyAuth(), instances.FindInstances)
		v1.POST("/instances", middleware.APIKeyAuth(), middleware.JWTAuth(), instances.CreateInstance)

		v1.POST("/login", middleware.APIKeyAuth(), auth.LoginHandler)
		v1.POST("/register", middleware.APIKeyAuth(), auth.RegisterHandler)
	}
	r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerfiles.Handler))

	return r
}
