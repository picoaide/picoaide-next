package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	addr := os.Getenv("PICOAI_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("picoaide-server"))
	})
	log.Printf("picoaide-server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
