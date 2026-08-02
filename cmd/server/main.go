package main

import (
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/knowledge"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
	"github.com/picoaide/picoaide/webadmin"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "./data", "data directory")
	bootstrapAdmin := flag.String("bootstrap-admin", "", "username of the initial admin (password from PICOAI_ADMIN_PASSWORD)")
	flag.Parse()

	if err := os.MkdirAll(*dataDir, 0700); err != nil {
		log.Fatalf("create data dir: %v", err)
	}
	db, err := serverstore.EnsureMigrated(*dataDir + "/picoaide.db")
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if *bootstrapAdmin != "" {
		if err := serverauth.EnsureBootstrapAdmin(db, *bootstrapAdmin); err != nil {
			log.Fatalf("bootstrap admin: %v", err)
		}
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())

	if _, err := util.EnsureMasterKey(*dataDir); err != nil {
		log.Fatalf("master key: %v", err)
	}
	// Upstream API keys are AES-GCM encrypted with the master key (Task 1.12).
	llmgateway.DecryptSecret = func(s string) (string, error) {
		key, err := util.GetMasterKey()
		if err != nil {
			return "", err
		}
		return util.Decrypt(key, s)
	}

	// 认证 provider 只按 ConfigureProviders 注册:auth.mode=ldap 时不注册 local,
	// 防止过期本地账号(含管理员)仍可登录
	authCfg := serverauth.NewConfiguredAPI(db)
	auth := authCfg.API
	if authCfg.OIDC != nil {
		auth.RegisterOIDC(authCfg.OIDC)
	}
	auth.RegisterRoutes(r)

	serverauth.RegisterAdminRoutes(r, db)
	llmgateway.RegisterRoutes(r, db)
	llmgateway.RegisterAdminRoutes(r, db)
	marketplace.RegisterRoutes(r, db, *dataDir+"/skills-cache")
	marketplace.RegisterAdminRoutes(r, db)
	knowledge.RegisterRoutes(r, db)
	knowledge.RegisterAdminRoutes(r, db)
	bootstrap.RegisterRoutes(r, db)
	serverstore.CleanupPendingUsage(db, time.Now().Add(-time.Hour))

	// webadmin SPA: /admin/ serves built assets with index.html fallback.
	dist, _ := fs.Sub(webadmin.FS, "dist")
	fileServer := http.FileServer(http.FS(dist))
	r.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		if p == "/admin" {
			c.Redirect(http.StatusFound, "/admin/")
			return
		}
		if len(p) >= 7 && p[:7] == "/admin/" {
			rel := strings.TrimPrefix(p, "/admin")
			if rel == "" {
				rel = "/"
			}
			if strings.HasPrefix(rel, "/assets/") {
				c.Request.URL.Path = rel
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
			index, err := dist.Open("index.html")
			if err != nil {
				c.String(http.StatusNotFound, "webadmin 未构建")
				return
			}
			defer index.Close()
			c.DataFromReader(http.StatusOK, -1, "text/html", index, nil)
			return
		}
		c.String(http.StatusNotFound, "not found")
	})

	log.Printf("picoaide-server listening on %s (data=%s)", *addr, *dataDir)
	if err := http.ListenAndServe(*addr, r); err != nil {
		log.Fatal(err)
	}
}
