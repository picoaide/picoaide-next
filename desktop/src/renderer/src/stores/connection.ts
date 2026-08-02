import { create } from 'zustand'

export type ConnectionStatus = 'online' | 'offline' | 'auth_expired'

interface ConnectionState {
  status: ConnectionStatus
  setStatus: (s: ConnectionStatus) => void
  reset: () => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'online',
  setStatus: (status) => set({ status }),
  reset: () => set({ status: 'online' }),
}))
