export class EmptyReplyError extends Error {
  constructor(message = 'Groq returned empty reply') {
    super(message);
    this.name = 'EmptyReplyError';
  }
}
