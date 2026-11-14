/** A web_fetch failure with the stable code its audit row records. */
export class WebFetchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
