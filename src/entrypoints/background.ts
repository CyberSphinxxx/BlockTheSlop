import { defineBackground } from 'wxt/utils/define-background';
import '@/background/index';

export default defineBackground(() => {
  // Initialization happens in @/background/index via synchronous event
  // listener registration; this callback confirms the worker started.
});
