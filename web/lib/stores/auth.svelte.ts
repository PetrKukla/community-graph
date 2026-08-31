/**
 * Tracks whether the API has rejected us for want of a valid key. `apiFetch` flips `needed`
 * on a 401; the TokenGate modal reads it, and `resolved()` (after a key is saved) bumps
 * `version` so the realtime socket effect tears down and reconnects with the new token.
 */
class AuthGate {
  needed = $state(false);
  version = $state(0);

  open(): void {
    this.needed = true;
  }

  resolved(): void {
    this.needed = false;
    this.version++;
  }
}

export const authGate = new AuthGate();
