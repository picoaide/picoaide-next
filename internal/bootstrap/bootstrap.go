// Package bootstrap aggregates the startup configuration for clients
// (GET /api/config/bootstrap): models + default model + skill/mcp suggestions.
package bootstrap

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// WebConfig mirrors the bootstrap `web` section.
type WebConfig struct {
	AllowPrivate   bool   `json:"allow_private"`
	SearchEndpoint string `json:"search_endpoint"`
}

// Response is the bootstrap payload. Field names are FIXED: the desktop
// client BootstrapConfig must align exactly.
type Response struct {
	DefaultModel string                `json:"default_model"`
	Models       []llmgateway.Model    `json:"models"`
	Skills       []SkillItem           `json:"skills"`
	MCP          []marketplace.MCPItem `json:"mcp"`
	Web          WebConfig             `json:"web"`
}

// RegisterRoutes mounts GET /api/config/bootstrap behind BearerAuth.
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	r.GET("/api/config/bootstrap", serverauth.BearerAuth(db), func(c *gin.Context) {
		resp, err := Build(db)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "启动配置生成失败")
			return
		}
		c.JSON(http.StatusOK, resp)
	})
}

// Build assembles the bootstrap payload.
func Build(db *sql.DB) (*Response, error) {
	models, err := llmgateway.ListModels(db)
	if err != nil {
		return nil, err
	}
	skills, err := serverstore.ListSkills(db, true)
	if err != nil {
		return nil, err
	}
	skillItems := make([]SkillItem, 0, len(skills))
	for _, sk := range skills {
		skillItems = append(skillItems, SkillItem{Name: sk.Name, Version: sk.Version, Description: sk.Description})
	}
	if err != nil {
		return nil, err
	}
	mcp, err := marketplace.SuggestedMCP(db)
	if err != nil {
		return nil, err
	}
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, err
	}
	defaultModel := settings["gateway.default_model"]
	if !modelEnabled(models, defaultModel) {
		log.Printf("bootstrap: default_model %q not in enabled models, falling back", defaultModel)
		if len(models) > 0 {
			defaultModel = models[0].ID
		} else {
			defaultModel = ""
		}
	}
	web := WebConfig{}
	if v, ok := settings["web.allow_private"]; ok {
		web.AllowPrivate, _ = strconv.ParseBool(v)
	}
	web.SearchEndpoint = settings["web.search_endpoint"]

	return &Response{
		DefaultModel: defaultModel,
		Models:       models,
		Skills:       skillItems,
		MCP:          mcp,
		Web:          web,
	}, nil
}

func modelEnabled(models []llmgateway.Model, id string) bool {
	if id == "" {
		return false
	}
	for _, m := range models {
		if m.ID == id {
			return true
		}
	}
	return false
}

// SkillItem is the bootstrap skill suggestion shape.
type SkillItem struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}
