export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "cg:theme";

function read(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage disabled */
  }
  return "system";
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

class ThemeStore {
  #theme = $state<Theme>(read());
  #systemDark = $state(prefersDark());

  /** The user's choice: light, dark, or follow the OS. */
  get theme(): Theme {
    return this.#theme;
  }

  /** What is actually shown right now. */
  get resolved(): "light" | "dark" {
    return this.#theme === "system" ? (this.#systemDark ? "dark" : "light") : this.#theme;
  }

  set(next: Theme): void {
    this.#theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage disabled */
    }
    this.#apply();
  }

  /** Flip between light and dark, dropping "system". */
  toggle(): void {
    this.set(this.resolved === "dark" ? "light" : "dark");
  }

  #apply(): void {
    document.documentElement.classList.toggle("dark", this.resolved === "dark");
  }

  /** Apply the current theme and track OS changes. Returns a cleanup function for `$effect`. */
  init(): () => void {
    this.#apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      this.#systemDark = e.matches;
      this.#apply();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }
}

export const theme = new ThemeStore();
