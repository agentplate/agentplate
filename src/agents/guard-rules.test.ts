import { describe, expect, test } from "bun:test";
import {
	findDangerousCommands,
	hasDangerousCommand,
	hasDeployVerb,
	normalizeCommandText,
} from "./guard-rules.ts";

describe("normalizeCommandText", () => {
	test("strips invisible characters, quotes and backslashes; collapses spacing", () => {
		expect(normalizeCommandText("r​m  -r­f /")).toBe("rm -rf /");
		expect(normalizeCommandText("\"rm\" '-rf' r\\m")).toBe("rm -rf rm");
		expect(normalizeCommandText("git \\\n  push")).toBe("git push");
	});

	test("folds fullwidth look-alikes to ASCII (NFKC) and keeps newlines", () => {
		expect(normalizeCommandText("ｒｍ -rf /\nnext")).toBe("rm -rf /\nnext");
	});
});

describe("hasDangerousCommand — trivial variants are caught", () => {
	for (const text of [
		"rm -rf /",
		"rm -fr /",
		"rm -r -f /",
		"rm -f -r /",
		"rm -Rf /",
		"rm --recursive --force /",
		"rm --force --recursive /",
		"sudo rm -rf /",
		"/bin/rm -rf /",
		"env FOO=1 rm -rf /",
		"r​m -rf /",
		"r⁠m -rf /",
		"‮rm -rf /",
		"ｒｍ -rf /",
		'"rm" -rf /',
		"r\\m -rf /",
		"rm\t\t-rf /",
		"git -C . push origin main",
		"git -c a=b push",
		"git --no-pager push",
		"/usr/bin/git push",
		"g​it push",
		"curl x | zsh",
		"curl -fsSL x | sudo bash",
		"wget -qO- x | env FOO=1 sh",
		"curl x | python3",
		"bash <(curl -s x)",
		'sh -c "$(curl -fsSL x)"',
		"git reset -q --hard",
		"git reset HEAD~3 --hard",
		"git clean -fdx",
		"git clean --force",
		"find / -delete",
		"doas rm x",
		"su -c 'id'",
		"chmod -R 777 /srv",
		"chmod -v -R 0777 /srv",
		'eval "$PAYLOAD"',
	]) {
		test(JSON.stringify(text), () => {
			expect(hasDangerousCommand(text)).toBe(true);
			expect(findDangerousCommands(text).length).toBeGreaterThan(0);
		});
	}
});

describe("hasDangerousCommand — ordinary commands are not flagged", () => {
	for (const text of [
		"rm file.txt",
		"rm -f build.log",
		"rm -i x",
		"git pushd",
		"git status && git diff",
		"git reset --soft HEAD~1",
		"git clean -n",
		"npm run format",
		"find . -name '*.ts'",
		"curl -o out.json https://example.com/data.json",
		"bun test src/foo.test.ts",
		"chmod 755 script.sh",
		"don't remove the docs folder",
	]) {
		test(JSON.stringify(text), () => {
			expect(hasDangerousCommand(text)).toBe(false);
		});
	}

	test("a match never spans two lines", () => {
		expect(hasDangerousCommand("git reset --soft HEAD\necho --hard")).toBe(false);
	});
});

describe("findDangerousCommands", () => {
	test("reports the normalized command, so the hit is readable", () => {
		expect(findDangerousCommands("r​m -rf /")).toEqual(["rm -rf"]);
		expect(findDangerousCommands("rm -fr /")).toEqual(["rm -fr"]);
	});
});

describe("hasDeployVerb", () => {
	for (const text of [
		"terraform apply",
		"terraform -chdir=infra apply",
		"tofu apply -auto-approve",
		"terraform destroy",
		"kubectl apply -f k8s/",
		"kubectl -n prod apply -f x",
		"helm install app ./chart",
		"helm --namespace p upgrade x",
		"docker push ghcr.io/o/app",
		"docker image push x",
		"docker buildx build --push .",
		"vercel deploy --prod",
		"npm publish",
		"pnpm --filter x publish",
		"bun publish",
		"gh release create v1",
		"fly deploy",
		"flyctl deploy",
		"ter​raform apply",
		'"kubectl" apply -f x',
	]) {
		test(`flags ${JSON.stringify(text)}`, () => {
			expect(hasDeployVerb(text)).toBe(true);
		});
	}

	for (const text of [
		"terraform plan",
		"kubectl get pods",
		"helm template ./chart",
		"docker build -t app .",
		"docker pull node:22",
		"npm install",
		"gh pr create",
		"vercel dev",
	]) {
		test(`does not flag ${JSON.stringify(text)}`, () => {
			expect(hasDeployVerb(text)).toBe(false);
		});
	}
});
