package serverauth

import (
	"database/sql"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ConfigureProviders reads auth settings and returns the password providers
// and optional browser provider to register on the API. Settings:
//
//	auth.mode        local | ldap | both (default local)
//	ldap.*           server_url/bind_dn/bind_password/base_dn/user_filter/group_filter/group_attr
//	oidc.*           issuer/client_id/client_secret/redirect_url
//
// Unconfigured providers are omitted; a broken ldap/oidc config degrades to
// nothing rather than failing startup.
func ConfigureProviders(db *sql.DB) ([]PasswordProvider, BrowserProvider) {
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, nil
	}
	mode := settings["auth.mode"]
	if mode == "" {
		mode = "local"
	}
	var pwds []PasswordProvider
	switch mode {
	case "local":
		pwds = append(pwds, NewLocalProvider(db))
	case "ldap":
		if p := ldapFromSettings(settings); p != nil {
			pwds = append(pwds, p)
		}
	case "both":
		pwds = append(pwds, NewLocalProvider(db))
		if p := ldapFromSettings(settings); p != nil {
			pwds = append(pwds, p)
		}
	}
	var browser BrowserProvider
	if p := oidcFromSettings(settings); p != nil {
		browser = p
	}
	return pwds, browser
}

func ldapFromSettings(s map[string]string) PasswordProvider {
	p := &LDAPProvider{}
	if err := p.Configure(stripPrefix(s, "ldap.")); err != nil {
		return nil
	}
	return p
}

func oidcFromSettings(s map[string]string) BrowserProvider {
	p := &OIDCProvider{}
	if err := p.Configure(stripPrefix(s, "oidc.")); err != nil {
		return nil
	}
	return p
}

func stripPrefix(m map[string]string, prefix string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		if strings.HasPrefix(k, prefix) {
			out[strings.TrimPrefix(k, prefix)] = v
		}
	}
	return out
}
