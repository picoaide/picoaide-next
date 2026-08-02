package serverstore

import "errors"

var (
	ErrNotFound = errors.New("not found")
	ErrDuplicate = errors.New("duplicate")
)
