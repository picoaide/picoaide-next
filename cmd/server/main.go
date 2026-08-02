package main

import (
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/knowledge"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
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

	auth := serverauth.New(db)
	auth.RegisterProvider(serverauth.NewLocalProvider(db))
	auth.RegisterRoutes(r)

	llmgateway.RegisterRoutes(r, db)
	marketplace.RegisterRoutes(r, db, *dataDir+"/skills-cache")
	knowledge.RegisterRoutes(r, db)

	// webadmin static (placeholder until built; replaced in Task 1.16c)
	dist, _ := fs.Sub(webadmin.FS, "dist")
	r.NoRoute(func(c *gin.Context) {
		if c.Request.URL.Path == "/admin" || len(c.Request.URL.Path) >= 7 && c.Request.URL.Path[:7] == "/admin/" {
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
