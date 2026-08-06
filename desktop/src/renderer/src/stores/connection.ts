import { create } from 'zustand'

export type ConnectionStatus = 'online' | 'offline' | 'auth_expired' | 'cert_mismatch'

interface ConnectionState {
  status: ConnectionStatus
  browserConnected: boolean
  setStatus: (s: ConnectionStatus) => void
  setBrowserConnected: (connected: boolean) => void
  reset: () => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'online',
  browserConnected: false,
  setStatus: (status) => set({ status }),
  setBrowserConnected: (browserConnected) => set({ browserConnected }),
  reset: () => set({ status: 'online', browserConnected: false }),
}))
