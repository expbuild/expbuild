package models

import "time"

type Instance struct {
	ID         uint      `json:"id" gorm:"primary_key"`
	InstanceID string    `json:"instance_id"`
	Comment    string    `json:"comment"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt  time.Time `json:"updated_at" gorm:"autoUpdateTime"`
}

type CreateInstance struct {
	InstanceID string `json:"instance_id" binding:"required"`
	Comment    string `json:"comment" binding:"required"`
}

type UpdateInstance struct {
	Comment string `json:"comment"`
}
