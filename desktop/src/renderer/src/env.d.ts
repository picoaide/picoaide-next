/// <reference types="vite/client" />
import type { PicoaideAPI } from '../../preload'

declare global {
  interface Window {
    picoaide: PicoaideAPI
  }
}
