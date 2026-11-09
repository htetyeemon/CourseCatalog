import type { Role } from "./schemas/common.js";

export interface AuthContext {
  sub: string;
  role: Role;
}

export interface AppVariables {
  requestId: string;
  auth: AuthContext | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
