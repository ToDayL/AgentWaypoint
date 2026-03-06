export type CurrentUser = {
  id: string;
  email: string;
};

export type AuthenticatedRequest = {
  currentUser?: CurrentUser;
  headers: Record<string, string | string[] | undefined>;
};
