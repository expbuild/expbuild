package instances

import (
	"net/http"
	"strconv"

	"github.com/expbuild/expbuild/pkg/database"
	"github.com/expbuild/expbuild/pkg/models"
	"github.com/gin-gonic/gin"
)

// FindBooks godoc
// @Summary Get all books with pagination
// @Description Get a list of all books with optional pagination
// @Tags books
// @Security ApiKeyAuth
// @Produce json
// @Param offset query int false "Offset for pagination" default(0)
// @Param limit query int false "Limit for pagination" default(10)
// @Success 200 {array} models.Book "Successfully retrieved list of books"
// @Router /books [get]
func FindInstances(c *gin.Context) {
	var instances []models.Instance

	// Get query params
	offsetQuery := c.DefaultQuery("offset", "0")
	limitQuery := c.DefaultQuery("limit", "10")

	// Convert query params to integers
	offset, err := strconv.Atoi(offsetQuery)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid offset format"})
		return
	}

	limit, err := strconv.Atoi(limitQuery)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid limit format"})
		return
	}

	// If cache missed, fetch data from the database
	database.DB.Offset(offset).Limit(limit).Find(&instances)
	c.JSON(http.StatusOK, gin.H{"data": instances})
}

// CreateBook godoc
// @Summary Create a new book
// @Description Create a new book with the given input data
// @Tags books
// @Security ApiKeyAuth
// @Security JwtAuth
// @Accept  json
// @Produce  json
// @Param   input     body   models.CreateBook   true   "Create book object"
// @Success 201 {object} models.Book "Successfully created book"
// @Failure 400 {string} string "Bad Request"
// @Failure 401 {string} string "Unauthorized"
// @Router /books [post]
func CreateInstance(c *gin.Context) {
	var input models.CreateInstance

	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	instance := models.Instance{InstanceID: input.InstanceID, Comment: input.Comment}

	database.DB.Create(&instance)

	c.JSON(http.StatusCreated, gin.H{"data": instance})
}

// StartInstance godoc
// @Summary Start a instance by ID
// @Description start the instance with the given ID
// @Tags instances
// @Security ApiKeyAuth
// @Produce json
// @Param id path string true "Instance ID"
// @Success 204 {string} string "Successfully start Instance"
// @Failure 404 {string} string "instance not found"
// @Router /instances/{id} [post]
func StartInstance(c *gin.Context) {
	var book models.Book

	if err := database.DB.Where("id = ?", c.Param("id")).First(&book).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "book not found"})
		return
	}

	database.DB.Delete(&book)

	c.JSON(http.StatusNoContent, gin.H{"data": true})
}
