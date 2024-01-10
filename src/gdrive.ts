import { createWriteStream } from "node:fs";
import { auth, drive_v3 } from "@googleapis/drive";
import { env } from "bun";

/**
 * Google Drive API client with scopes of `drive.readonly` and `drive.file`.
 */
export const driveClient = new drive_v3.Drive({
	auth: new auth.GoogleAuth({
		credentials: {
			// biome-ignore lint/style/useNamingConvention: library's naming convention
			client_email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
			// replace \n with actual newlines
			// biome-ignore lint/style/useNamingConvention: library's naming convention
			private_key: env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
		},
		// ref: https://developers.google.com/identity/protocols/oauth2/scopes#drive
		scopes: [
			// required to download files
			"https://www.googleapis.com/auth/drive.readonly",
			// required to upload files
			"https://www.googleapis.com/auth/drive.file",
		],
	}),
});

/**
 * Extract Google Drive file ID from a URL.
 * @param url Google Drive URL
 * @returns Google Drive file ID
 */
export const extractFileId = (url: string): string | undefined => {
	// file ID is the path segment after d (files), e (forms), or folders
	// ref: https://github.com/spamscanner/url-regex-safe/blob/6c1e2c3b5557709633a2cc971d599469ea395061/src/index.js#L80
	// ref: https://stackoverflow.com/questions/16840038/easiest-way-to-get-file-id-from-url-on-google-apps-script
	const regex =
		/^https?:\/\/(?:drive|docs)\.google\.com\/[^\s'"\)]+\/(?:d|e|folders)\/([-\w]{25,})(?:\/[^\s'"\)]*[^\s"\)'.?!])?$/g;
	return regex.exec(url)?.[1];
};

/**
 * Download a file from Google Drive.
 */
export const downloadFile = async (fileId: string, path: string) =>
	driveClient.files
		.get(
			{
				fileId: fileId,
				alt: "media",
			},
			{
				responseType: "stream",
			},
		)
		.then(
			({ data }) =>
				new Promise<string>((resolve, reject) => {
					data
						.on("end", () => {
							resolve(path);
						})
						.on("error", reject)
						.pipe(createWriteStream(path));
				}),
		);
