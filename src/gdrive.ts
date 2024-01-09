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
