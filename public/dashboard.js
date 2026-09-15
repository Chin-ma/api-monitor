function getStatus(ep) {
  if (!ep.known) return "UNKNOWN";
  const rate = parseFloat(ep.errorRate);
  if (rate >= 5) return "CRITICAL";
  if (rate > 0) return "WARNING";
  return "OK";
}

async function loadStats() {
  const res = await fetch("/stats");
  const data = await res.json();

  document.getElementById("summary").textContent =
    `Total requests: ${data.total} | Total 5xx errors: ${data.errors5xx} | Overall error rate: ${data.errorRate}`;

  const rowsHtml = data.endpoints.map(ep => {
    const status = getStatus(ep);

    return `
      <tr class="${status}">
        <td>${ep.service || "-"}</td>
        <td>${ep.path}</td>
        <td>${ep.total}</td>
        <td>${ep.errors5xx}</td>
        <td>${ep.errorRate}</td>
        <td>${ep.p50} ms</td>
        <td>${ep.p95} ms</td>
        <td>${status}</td>
      </tr>
    `;
  }).join("");

  document.getElementById("rows").innerHTML = rowsHtml;
}

loadStats();
setInterval(loadStats, 3000);
