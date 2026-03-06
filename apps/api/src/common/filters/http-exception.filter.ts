import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

type ErrorPayload = {
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
  };
};

const STATUS_CODE_MAP: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_SERVER_ERROR',
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<{ status: (code: number) => { send: (payload: unknown) => void } }>();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();

      let message = 'Request failed';
      let details: unknown;

      if (typeof response === 'string') {
        message = response;
      } else if (typeof response === 'object' && response !== null) {
        const responseRecord = response as Record<string, unknown>;
        const responseMessage = responseRecord.message;

        if (Array.isArray(responseMessage)) {
          message = responseMessage.join('; ');
        } else if (typeof responseMessage === 'string') {
          message = responseMessage;
        }

        if ('details' in responseRecord) {
          details = responseRecord.details;
        }
      }

      const payload: ErrorPayload = {
        error: {
          code: STATUS_CODE_MAP[statusCode] ?? 'HTTP_ERROR',
          message,
          statusCode,
          details,
        },
      };

      void reply.status(statusCode).send(payload);
      return;
    }

    const payload: ErrorPayload = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      },
    };

    // Keep one server-side stack trace for fast diagnosis while returning safe payload.
    // eslint-disable-next-line no-console
    console.error(exception);
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(payload);
  }
}
