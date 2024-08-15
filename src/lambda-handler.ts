import { Buffer } from 'buffer';
import { Args, resizeBuffer } from './lib.js';
/**
 *
 * @param event
 * @param response
 */
import { URLSearchParams } from 'url';

const streamify_handler: StreamifyHandler = async (event, response) => {
  const key = decodeURIComponent(event.rawPath.substring(1)).replace('/tachyon/', '/');
  const args = (event.queryStringParameters || {}) as unknown as Args & {
    'X-Amz-Expires'?: string;
    'presign'?: string;
    key: string;
  };
  args.key = key;

  if (typeof args.webp === 'undefined') {
    args.webp = !!(event.headers && Object.keys(event.headers).find(key => key.toLowerCase() === 'x-webp'));
  }

  // If there is a presign param, we need to decode it and add it to the args.
  if (args.presign) {
    const presignArgs = new URLSearchParams(args.presign);
    for (const [key, value] of presignArgs.entries()) {
      args[key as keyof Args] = value;
    }
    delete args.presign;
  }

  const originalUrl = `${process.env.DOMAIN}/${key}`;

  let fetchResponse;

  try {
    fetchResponse = await fetch(originalUrl);

    if (!fetchResponse.ok) {
      throw new Error(`HTTP error! status: ${fetchResponse.status}`);
    }
  } catch (e: any) {
    if (e.message.includes('404') || fetchResponse?.status === 404) {
      const metadata = {
        statusCode: 404,
        headers: {
          'Content-Type': 'text/html',
        },
      };
      response = awslambda.HttpResponseStream.from(response, metadata);
      response.write('File not found.');
      response.end();
      return;
    }
    throw e;
  }

  const buffer = await fetchResponse.arrayBuffer();
  let { info, data } = await resizeBuffer(Buffer.from(buffer), args);

  // If this is a signed URL, we need to calculate the max-age of the image.
  const maxAge = 31536000; // 1 year.
  response = awslambda.HttpResponseStream.from(response, {
    statusCode: 200,
    headers: {
      'Cache-Control': `max-age=${maxAge}`,
      'Last-Modified': (new Date()).toUTCString(),
      'Content-Type': 'image/' + info.format,
    },
  });
  response.write(data);
  response.end();
};

if ( typeof awslambda === 'undefined' ) {
	global.awslambda = {
		/**
		 *
		 * @param handler
		 */
		streamifyResponse( handler: StreamifyHandler ): StreamifyHandler {
			return handler;
		},
		HttpResponseStream: {
			/**
			 * @param response The response stream object
			 * @param metadata The metadata object
			 * @param metadata.headers
			 */
			from( response: ResponseStream, metadata: {
				headers?: Record<string, string>,
			} ): ResponseStream {
				response.metadata = metadata;
				return response;
			},
		},
	};
}

export const handler = awslambda.streamifyResponse( streamify_handler );
