export function getXAuthToken(): string | null {
  return process.env.X_AUTH_TOKEN?.trim() || null;
}

export function getXCt0(): string | null {
  return process.env.X_CT0?.trim() || null;
}

export function getXHandle(): string | null {
  return process.env.X_HANDLE?.trim() || null;
}
