package serverstore

import "errors"

var (
	ErrNotFound  = errors.New("not found")
	ErrDuplicate = errors.New("duplicate")
	// ErrLastAdmin is returned when a delete would leave zero admin accounts
	// (rolls back; see DeleteUser).
	ErrLastAdmin = errors.New("cannot delete the last admin")
)
