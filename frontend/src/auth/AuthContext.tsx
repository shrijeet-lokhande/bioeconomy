import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  authApi,
  type AuthUser,
  type LoginPayload,
  type RegisterPayload,
} from "../lib/api";

export type AuthStatus = "loading" | "ready";

interface AuthContextValue {
  readonly user: AuthUser | null;
  readonly status: AuthStatus;
  /** True when a user is signed in with a live session. */
  readonly isAuthenticated: boolean;
  login(payload: LoginPayload): Promise<AuthUser>;
  /** Registers the account. Does NOT sign the user in; email verification
   * is deferred (see docs), so the flow redirects to login afterwards. */
  register(payload: RegisterPayload): Promise<AuthUser>;
  logout(): Promise<void>;
  /** Clears local user state after an unexpected 401 (expired session). */
  clearUser(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Owns session state. On mount it restores the authenticated user from the
 * backend session cookie (GET /auth/me), which is also how a page refresh
 * keeps the user signed in.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((restored) => {
        if (!cancelled) {
          setUser(restored);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setStatus("ready");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (payload: LoginPayload) => {
    const signedIn = await authApi.login(payload);
    setUser(signedIn);
    return signedIn;
  }, []);

  const register = useCallback(async (payload: RegisterPayload) => {
    return authApi.register(payload);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      // Local state is cleared even if the request failed mid-way; the
      // browser cookie is HttpOnly and managed by the server.
      setUser(null);
    }
  }, []);

  const clearUser = useCallback(() => setUser(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isAuthenticated: status === "ready" && user !== null,
      login,
      register,
      logout,
      clearUser,
    }),
    [user, status, login, register, logout, clearUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used inside <AuthProvider>.");
  }
  return context;
}
