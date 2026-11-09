#!/bin/sh
set -eu
: "${PLANTUML_JAR:?Set PLANTUML_JAR to the official PlantUML jar}"
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for name in use-case activity sequence mobile-class erd gantt; do
  java -Djava.awt.headless=true -jar "$PLANTUML_JAR" -tsvg "$dir/$name.puml"
  dpi=150
  [ "$name" != gantt ] || dpi=200
  java -Djava.awt.headless=true -jar "$PLANTUML_JAR" -tpng "-Sdpi=$dpi" "$dir/$name.puml"
done
