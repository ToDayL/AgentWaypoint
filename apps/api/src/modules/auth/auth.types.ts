export type CurrentUser = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  authMethod: 'session' | 'password' | 'dev_header';
};

export type RequestPrincipal =
  | {
      type: 'user';
      userId: string;
      email: string;
      role: 'admin' | 'user';
      authMethod: 'session' | 'password' | 'dev_header';
    };

export type AuthenticatedRequest = {
  principal?: RequestPrincipal;
  currentUser?: CurrentUser;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
};
