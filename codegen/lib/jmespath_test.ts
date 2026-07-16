import { compileJMESPath } from './jmespath.ts';
import { assertEquals } from "@std/assert/equals";

const cases: Record<string,string> = {
  "EndpointStatus": "resp?.EndpointStatus",
  "length(Reservations[]) > `0`": "(resp?.Reservations || '').length > 0",
  "Reservations[].Instances[].State.Name": "resp?.Reservations?.flatMap(x => x?.Instances)?.flatMap(x => x?.State?.Name)",
  "length(KeyPairs[].KeyName) > `0`": "(resp?.KeyPairs?.flatMap(x => x?.KeyName) || '').length > 0",
  "length(DBClusterSnapshots) == `0`": "(resp?.DBClusterSnapshots || '').length == 0",
  "length(services[?!(length(deployments) == `1` && runningCount == desiredCount)]) == `0`": "(resp?.services?.filter(x => !((x?.deployments || '').length == 1 && x?.runningCount == x?.desiredCount)) || '').length == 0",
  "VerificationAttributes.*.VerificationStatus": "Object.values(resp?.VerificationAttributes).map(x => x?.VerificationStatus)",
};

for (const [path, compiled] of Object.entries(cases)) {
  Deno.test(`JMESPath: ${path}`, () => {
    assertEquals(compileJMESPath(path, 'resp'), compiled);
  });
}
