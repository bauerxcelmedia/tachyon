import { S3Client, S3ClientConfig, GetObjectCommand, GetObjectCommandOutput } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import smartcrop from 'smartcrop-sharp';

export interface Args {
	// Optional args.
	background?: string;
	crop?: string | string[];
	crop_strategy?: string;
	fit?: string;
	gravity?: string;
	h?: string;
	lb?: string;
	resize?: string | number[];
	quality?: string | number;
	w?: string;
	webp?: string | boolean;
	zoom?: string;
	avif?: string | boolean;
	'X-Amz-Algorithm'?: string;
	'X-Amz-Content-Sha256'?: string;
	'X-Amz-Credential'?: string;
	'X-Amz-SignedHeaders'?: string;
	'X-Amz-Expires'?: string;
	'X-Amz-Signature'?: string;
	'X-Amz-Date'?: string;
	'X-Amz-Security-Token'?: string;
}

export type Config = S3ClientConfig & { bucket: string };

/**
 * Get the dimensions from a string or array of strings.
 */
function getDimArray( dims: string | number[], zoom: number = 1 ): ( number | null )[] {
	let dimArr = typeof dims === 'string' ? dims.split( ',' ) : dims;
	return dimArr.map( v => Math.round( Number( v ) * zoom ) || null );
}

/**
 * Clamp a value between a min and max.
 */
function clamp( val: number | string, min: number, max: number ): number {
	return Math.min( Math.max( Number( val ), min ), max );
}

/**
 * Get a file from S3/
 */
export async function getS3File( config: Config, key: string, args: Args ): Promise<GetObjectCommandOutput> {
	const s3 = new S3Client( {
		...config,
		signer: {
			/**
			 *
			 * @param request
			 */
			sign: async request => {
				if ( ! args['X-Amz-Algorithm'] ) {
					return request;
				}
				const presignedParamNames = [
					'X-Amz-Algorithm',
					'X-Amz-Content-Sha256',
					'X-Amz-Credential',
					'X-Amz-SignedHeaders',
					'X-Amz-Expires',
					'X-Amz-Signature',
					'X-Amz-Date',
					'X-Amz-Security-Token',
				] as const;
				const presignedParams: { [K in ( typeof presignedParamNames )[number]]?: string } = {}; // eslint-disable-line no-unused-vars
				const signedHeaders = ( args['X-Amz-SignedHeaders']?.split( ';' ) || [] ).map( header => header.toLowerCase().trim() );

				for ( const paramName of presignedParamNames ) {
					if ( args[paramName] ) {
						presignedParams[paramName] = args[paramName];
					}
				}

				const headers: typeof request.headers = {};
				for ( const header in request.headers ) {
					if ( signedHeaders.includes( header.toLowerCase() ) ) {
						headers[header] = request.headers[header];
					}
				}
				request.query = presignedParams;

				request.headers = headers;
				return request;
			},
		},
	} );

	const command = new GetObjectCommand( {
		Bucket: config.bucket,
		Key: key,
	} );

	return s3.send( command );
}

/**
 * Apply a logarithmic compression to a value based on a zoom level.
 * return a default compression value based on a logarithmic scale
 * defaultValue = 100, zoom = 2; = 65
 * defaultValue = 80, zoom = 2; = 50
 * defaultValue = 100, zoom = 1.5; = 86
 * defaultValue = 80, zoom = 1.5; = 68
 */
function applyZoomCompression( defaultValue: number, zoom: number ): number {
	const value = Math.round( defaultValue - ( Math.log( zoom ) / Math.log( defaultValue / zoom ) ) * ( defaultValue * zoom ) );
	const min = Math.round( defaultValue / zoom );
	return clamp( value, min, defaultValue );
}

type ResizeBufferResult = {
	data: Buffer;
	info: sharp.OutputInfo & {
		errors: string;
	}
};

/**
 * Resize a buffer of an image.
 */
export async function resizeBuffer(
	buffer: Buffer | Uint8Array,
	args: Args,
	paramOrder: string[]
): Promise<ResizeBufferResult> {
	const image = sharp( buffer, {
		failOnError: false,
		animated: true,
		limitInputPixels: false,
	} ).withMetadata();

	// check we can get valid metadata
	const metadata = await image.metadata();

	let width = metadata.width as number;
	let height = metadata.height as number;

	// auto rotate based on orientation EXIF data.
	image.rotate();

	// validate args, remove from the object if not valid
	const errors: string[] = [];

	if ( args.w ) {
		if ( ! /^[1-9]\d*$/.test( args.w ) ) {
			delete args.w;
			errors.push( 'w arg is not valid' );
		}
	}
	if ( args.h ) {
		if ( ! /^[1-9]\d*$/.test( args.h ) ) {
			delete args.h;
			errors.push( 'h arg is not valid' );
		}
	}
	if ( args.quality ) {
		if (
			! /^[0-9]{1,3}$/.test( args.quality as string ) ||
			( args.quality as number ) < 0 ||
			( args.quality as number ) > 100
		) {
			delete args.quality;
			errors.push( 'quality arg is not valid' );
		}
	}
	if ( args.resize ) {
		if ( ! /^\d+(px)?,\d+(px)?$/.test( args.resize as string ) ) {
			delete args.resize;
			errors.push( 'resize arg is not valid' );
		}
	}
	if ( args.crop_strategy ) {
		if ( ! /^(smart|entropy|attention)$/.test( args.crop_strategy ) ) {
			delete args.crop_strategy;
			errors.push( 'crop_strategy arg is not valid' );
		}
	}
	if ( args.gravity ) {
		if ( ! /^(north|northeast|east|southeast|south|southwest|west|northwest|center)$/.test( args.gravity ) ) {
			delete args.gravity;
			errors.push( 'gravity arg is not valid' );
		}
	}
	if ( args.fit ) {
		if ( ! /^\d+(px)?,\d+(px)?$/.test( args.fit as string ) ) {
			delete args.fit;
			errors.push( 'fit arg is not valid' );
		}
	}
	if ( args.crop ) {
		if ( ! /^\d+(px)?,\d+(px)?,\d+(px)?,\d+(px)?$/.test( args.crop as string ) ) {
			delete args.crop;
			errors.push( 'crop arg is not valid' );
		}
	}
	if ( args.zoom ) {
		if ( ! /^\d+(\.\d+)?$/.test( args.zoom ) ) {
			delete args.zoom;
			errors.push( 'zoom arg is not valid' );
		}
	}
	if ( args.webp ) {
		if ( ! /^0|1|true|false$/.test( args.webp as string ) ) {
			delete args.webp;
			errors.push( 'webp arg is not valid' );
		}
	}
	if ( args.avif ) {
		if ( ! /^0|1|true|false$/.test( args.avif as string ) ) {
			delete args.avif;
			errors.push( 'avif arg is not valid' );
		}
	}
	if ( args.lb ) {
		if ( ! /^\d+(px)?,\d+(px)?$/.test( args.lb ) ) {
			delete args.lb;
			errors.push( 'lb arg is not valid' );
		}
	}
	if ( args.background ) {
		if ( ! /^#[a-f0-9]{3}[a-f0-9]{3}?$/.test( args.background ) ) {
			delete args.background;
			errors.push( 'background arg is not valid' );
		}
	}

	// get zoom value
	const zoom = parseFloat( args.zoom || '1' ) || 1;

	// If crop exists move crop to first and remove from previous position
	// Note AWS doesn't preseve order of query string params
	if ( args.crop ) {
		paramOrder = paramOrder.filter( param => param !== 'crop' );
		paramOrder.unshift( 'crop' );
	}

	for (const param of paramOrder) {
		switch (param) {
			// resize
			case 'resize': {
				if (args.resize) {
					// apply smart crop if available
					if (args.crop_strategy === 'smart' && !args.crop) {
						const cropResize = getDimArray(args.resize);
						const rotatedImage = await image.toBuffer();
						const result = await smartcrop.crop(rotatedImage, {
							width: cropResize[0] as number,
							height: cropResize[1] as number,
						});

						if (result && result.topCrop) {
							image.extract({
								left: result.topCrop.x,
								top: result.topCrop.y,
								width: result.topCrop.width,
								height: result.topCrop.height,
							});
							width = result.topCrop.width;
							height = result.topCrop.height;
						}
					}

					// apply the resize
					const [resizeWidth, resizeHeight] = getDimArray(args.resize, zoom) as number[];
					const scale = Math.min(
						resizeWidth / width,
						resizeHeight / height,
						1 // Prevent enlargement
					);
					const newWidth = Math.round(width * scale);
					const newHeight = Math.round(height * scale);

					image.resize({
						width: newWidth,
						height: newHeight,
						withoutEnlargement: true,
						position: (args.crop_strategy !== 'smart' && args.crop_strategy) || args.gravity || 'centre',
					});
					width = newWidth;
					height = newHeight;
				}
				break;
			}
			case 'fit': {
				if (args.fit) {
					const [targetWidth, targetHeight] = getDimArray(args.fit, zoom) as number[];

					const scale = Math.min(
						targetWidth / width,
						targetHeight / height,
						1 // This ensures we don't enlarge the image
					);
					width = Math.round(width * scale);
					height = Math.round(height * scale);

					image.resize({
						width,
						height,
						fit: 'inside',
						withoutEnlargement: true,
					});
				}
				break;
			}
			case 'lb': {
				if (args.lb) {
					const lb = getDimArray(args.lb, zoom) as number[];
					image.resize({
						width: lb[0],
						height: lb[1],
						fit: 'contain',
						background: args.background || 'black',
						withoutEnlargement: true,
					});
					width = lb[0];
					height = lb[1];
				}
				break;
			}
			case 'h':
			case 'w': {
				if (args.w || args.h) {
					const newWidth = Number(args.w) || width;
					const newHeight = Number(args.h) || height;
					const aspectRatio = height / width;

					if (args.w && !args.h) {
						height = Math.round(newWidth * aspectRatio);
						width = newWidth;
					} else if (args.h && !args.w) {
						width = Math.round(newHeight / aspectRatio);
						height = newHeight;
					} else {
						width = newWidth;
						height = newHeight;
					}

					image.resize({
						width: width * zoom,
						height: height * zoom,
						fit: args.crop ? 'cover' : 'inside',
						withoutEnlargement: true,
					});
				}
				break;
			}
			case 'crop': {
				if (args.crop) {
					const cropValuesString = typeof args.crop === 'string' ? args.crop.split(',') : args.crop;

					// convert percentages and px values to numbers
					const cropValues = cropValuesString.map((value, index) => {
						if (value.endsWith('px')) {
							return Number(value.slice(0, -2));
						} else {
							const dimension = index % 2 === 0 ? width : height;
							return Math.round(dimension * (Number(value) / 100));
						}
					});

					let [x, y, w, h] = cropValues;

					// Ensure crop dimensions don't exceed image boundaries
					x = Math.min(Math.max(x, 0), width);
					y = Math.min(Math.max(y, 0), height);
					w = Math.min(Math.max(w, 1), width - x);  // Ensure width is at least 1
					h = Math.min(Math.max(h, 1), height - y); // Ensure height is at least 1

					image.extract({
						left: x,
						top: y,
						width: w,
						height: h
					});

					width = w;
					height = h;
				}
				break;
			}
			default:
				break;
		}
	}

	// set default quality slightly higher than sharp's default
	if ( ! args.quality ) {
		args.quality = applyZoomCompression( 82, zoom );
	}

	// allow override of compression quality
	if ( args.avif ) {
		image.avif( {
			quality: Math.round( clamp( args.quality, 0, 100 ) ),
		} );
	} else if ( args.webp ) {
		image.webp( {
			quality: Math.round( clamp( args.quality, 0, 100 ) ),
		} );
	} else if ( metadata.format === 'jpeg' ) {
		image.jpeg( {
			quality: Math.round( clamp( args.quality, 0, 100 ) ),
		} );
	} else if ( metadata.format === 'png' ) {
		// Compress the PNG.
		image.png( {
			palette: true,
		} );
	}

	// send image
	return new Promise( ( resolve, reject ) => {
		image.toBuffer( async ( err, data, info ) => {
			if ( err ) {
				reject( err );
			}

			// add invalid args
			resolve( {
				data,
				info: {
					...info,
					errors: errors.join( ';' ),
				},
			} );
		} );
	} );
}
