package serverauth

import "github.com/gin-gonic/gin"

// Stubs replaced by the real OIDC flow in Task 1.7.
func (a *API) handleOIDCLogin(c *gin.Context)    { writeError(c, 404, "NOT_FOUND", "OIDC 未配置") }
func (a *API) handleOIDCCallback(c *gin.Context) { writeError(c, 404, "NOT_FOUND", "OIDC 未配置") }
