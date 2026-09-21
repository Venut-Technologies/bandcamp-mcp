export class BandcampUnavailableError extends Error {
  // The HTTP status Bandcamp answered with, when the failure was a non-OK
  // status; absent for network errors, timeouts, redirect faults and a
  // Retry-After too long to wait for.
  readonly status?: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "BandcampUnavailableError";
    if (options?.status !== undefined) this.status = options.status;
  }
}

export class BandcampShapeChangedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BandcampShapeChangedError";
  }
}

export class BandcampChallengeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BandcampChallengeError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NotFoundError";
  }
}
