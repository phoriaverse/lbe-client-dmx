// Both the transport button and Space resume the sequence, even after a fixture check.
import { preview } from "./preview";
import { getUi, rigStore, setUi } from "./state";

export function togglePlayback() {
  const { identify, walk } = getUi();
  if (identify || walk) {
    setUi({ identify: false, walk: false });
    // Clear the override immediately; don't wait for React's selection effect.
    preview.identify(rigStore.get(), null);
    preview.play();
  } else {
    preview.toggle();
  }
}
