package serverauth

// UserInfo is the normalized identity returned by providers.
type UserInfo struct {
	Username    string
	DisplayName string
	Email       string
	Groups      []string
}

// PasswordProvider authenticates via username/password (local/ldap).
type PasswordProvider interface {
	Name() string
	Authenticate(username, password string) (UserInfo, error)
	Configure(cfg map[string]string) error
}

// BrowserProvider authenticates via browser redirect flow (oidc).
type BrowserProvider interface {
	Name() string
	AuthURL(state string) (string, error)
	HandleCallback(code, state string) (UserInfo, error)
	Configure(cfg map[string]string) error
}
