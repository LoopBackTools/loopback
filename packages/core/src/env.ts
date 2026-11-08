/** The bindings a core Worker must declare, under these names. */
export interface CoreBindings {
	/** Uploaded images, under the space that holds them. */
	readonly FILES: R2Bucket;
	/**
	 * Which deploy the code is from. A space still running older code than the core calling it
	 * restarts onto the newer; without it, nothing is compared. Declare it in every deployment.
	 */
	readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}
