import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Buffer } from 'buffer';
import { Args, resizeBuffer, getS3File, Config } from './lib.js';
import { URLSearchParams } from 'url';

const streamify_handler: StreamifyHandler = async (event, response) => {
    const s3Client = new S3Client({ region: process.env.S3_REGION });
    const region = process.env.S3_REGION!;
    const bucket = process.env.S3_BUCKET!;
    const config: Config = {
        region: region,
        bucket: bucket,
    };
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
    let buffer;
    try {
        const s3Response = await getS3File(config, key, args);
        buffer = Buffer.from( await s3Response.Body.transformToByteArray() );
    } catch (error: any) {
        if (error.Code === 'NoSuchKey' || error.Code === 'AccessDenied') {
            try {
                fetchResponse = await fetch(originalUrl);
                if (!fetchResponse.ok) {
                    throw new Error(`HTTP error! status: ${fetchResponse.status}`);
                }
                buffer = Buffer.from(await fetchResponse.arrayBuffer());
                const params = {
                    Bucket: bucket,
                    Key: key,
                    Body: buffer,
                };
                const command = new PutObjectCommand(params);
                await s3Client.send(command);
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
        } else {
            throw error;
        }
    }
    let { info, data } = await resizeBuffer(buffer, args);
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

if (typeof awslambda === 'undefined') {
    global.awslambda = {
        streamifyResponse(handler: StreamifyHandler): StreamifyHandler {
            return handler;
        },
        HttpResponseStream: {
            from(response: ResponseStream, metadata: {
                headers?: Record<string, string>,
            }): ResponseStream {
                response.metadata = metadata;
                return response;
            },
        },
    };
}

export const handler = awslambda.streamifyResponse(streamify_handler);