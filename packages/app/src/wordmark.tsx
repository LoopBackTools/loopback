/**
 * Loopback's wordmark: "loopback" in the system face, its second "o" the loop mark. The mark is cut
 * out of whatever it sits on, so the arrowhead reads clearly where it meets the letters; that ground
 * is `--wordmark-ground`, the list's own colour unless a page says otherwise.
 */
export function Wordmark({ size = 22 }: { readonly size?: number }) {
	// The mark is drawn at the proportions of the logo set at 128px: 86 by 72, pulled 9 in on the left.
	const scale = size / 128;
	const ground = "var(--wordmark-ground, var(--color-kumo-recessed))";
	return (
		<span className="flex">
			{/* A screen reader says the name, rather than the "lo" and "pback" it is drawn with. */}
			<span className="sr-only">Loopback</span>
			<span
				aria-hidden
				className="flex items-baseline font-semibold text-kumo-strong"
				style={{
					fontSize: size,
					lineHeight: `${Math.round(size * 1.1)}px`,
					letterSpacing: "-0.045em",
				}}
			>
				<span>lo</span>
				<svg
					viewBox="2 4 86 72"
					width={86 * scale}
					height={72 * scale}
					style={{ marginLeft: -9 * scale, marginRight: 2 * scale }}
				>
					<path
						d="M25.49 54.15A28.3 28.3 0 1 0 25.49 25.85"
						fill="none"
						style={{ stroke: ground }}
						strokeWidth="21"
						strokeLinecap="round"
					/>
					<path
						d="M41.08 34.85 9.9 16.85 16.49 41.44Z"
						style={{ fill: ground, stroke: ground }}
						strokeWidth="9"
						strokeLinejoin="round"
					/>
					<path
						d="M25.49 54.15A28.3 28.3 0 1 0 25.49 25.85"
						fill="none"
						stroke="#F6821F"
						strokeWidth="15"
						strokeLinecap="round"
					/>
					<path
						d="M41.08 34.85 9.9 16.85 16.49 41.44Z"
						fill="#F6821F"
						stroke="#F6821F"
						strokeWidth="3"
						strokeLinejoin="round"
					/>
				</svg>
				<span>pback</span>
			</span>
		</span>
	);
}
