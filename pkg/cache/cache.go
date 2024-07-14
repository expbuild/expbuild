package cache

import (
	"context"

	"github.com/go-redis/redis/v8"
)

var Rdb *redis.Client
var Ctx = context.Background()

func InitRedis() {
	Rdb = redis.NewClient(&redis.Options{
		Addr:     "127.0.0.1:6379", // Redis server address
		Password: "",               // Password, leave empty if none
		DB:       0,                // Default DB
	})
}
