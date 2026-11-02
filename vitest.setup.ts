// Tests never touch the real macOS Keychain or Secure Enclave: no hardware store unless a test installs a mock.
import { beforeEach } from 'vitest';
import { setHardwareStore } from './src/hardwareOwner';

beforeEach(() => setHardwareStore(null));
