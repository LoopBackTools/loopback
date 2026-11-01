import { RegistryProvider } from "@effect/atom-react";
import { followSystemTheme } from "@loopbacktools/app";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.ts";
import "./styles.css";

followSystemTheme();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element.");

createRoot(root).render(
	<StrictMode>
		<RegistryProvider>
			<App />
		</RegistryProvider>
	</StrictMode>,
);
