# Diagrams

The six [presentation diagrams](presentation/) have editable PlantUML sources and matching SVG and PNG exports. SVG is useful for zooming or cropping dense details on a slide. The PlantUML ERD is a current core-schema excerpt; it does not replace the historical `database.mmd` and `database.svg` Mermaid artifacts.

| Source | Purpose |
| --- | --- |
| `use-case.puml` | Actors, authentication, private resources, external services |
| `activity.puml` | Alert qualification, rearming and failure paths |
| `sequence.puml` | Shared check, history, episode and channel dispatch |
| `mobile-class.puml` | Principal Flutter client and Android push classes |
| `erd.puml` | Shared offer, private tracker and security relationships |
| `gantt.puml` | Original October 26–November 15 plan, not a status report |

These are implementation models, not proof of deployed operation or external delivery. Source-policy approval for live history collection remains pending; do not collect history until approved. The original plan is not a claim that hosting, email or SwaggerHub publication is complete. Review with the relevant owners remains outstanding.

## Reproduce locally

Requires Java and the official PlantUML 1.2026.2 GPL jar. This uses the bundled Smetana layout, not Graphviz or a remote rendering service. Run from the repository root; the jar stays in the user cache, not the repository:

```sh
mkdir -p "$HOME/.cache/price-tracker-plantuml"
curl -fL -o "$HOME/.cache/price-tracker-plantuml/plantuml-1.2026.2.jar" https://github.com/plantuml/plantuml/releases/download/v1.2026.2/plantuml-1.2026.2.jar
echo '3cdce52133c424dea22425b947ae9d47f2167b0866dfcf99e714d4ea1689975c  '"$HOME"'/.cache/price-tracker-plantuml/plantuml-1.2026.2.jar' | sha256sum -c
PLANTUML_JAR="$HOME/.cache/price-tracker-plantuml/plantuml-1.2026.2.jar" docs/diagrams/presentation/render.sh
```

The script invokes `java -Djava.awt.headless=true -jar "$PLANTUML_JAR" -tsvg` and `-tpng -Sdpi=150` for each source; Gantt PNG uses 200 dpi. Rendered November 9, 2026 with PlantUML 1.2026.2 (bb8550d) and OpenJDK 25.0.5. Fonts and Java versions can affect layout. No provider, database, email, Firebase or remote PlantUML request is made by rendering.
