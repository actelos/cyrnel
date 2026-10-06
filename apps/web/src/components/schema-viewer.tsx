import type { JSONSchema } from "@/components/rjsf-form";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

function typeLabel(schema: JSONSchema): string {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.join(" | ");
  if (Array.isArray(schema.oneOf)) return "oneOf";
  if (Array.isArray(schema.anyOf)) return "anyOf";
  if (Array.isArray(schema.allOf)) return "allOf";
  if (typeof schema.properties === "object" && schema.properties !== null) {
    return "object";
  }
  if (Array.isArray(schema.enum)) return "enum";
  return "any";
}

function constraintBadges(schema: JSONSchema): string[] {
  const out: string[] = [];
  if (typeof schema.format === "string") out.push(`format: ${schema.format}`);
  if (typeof schema.pattern === "string")
    out.push(`pattern: ${schema.pattern}`);
  if (typeof schema.minLength === "number")
    out.push(`minLength: ${schema.minLength}`);
  if (typeof schema.maxLength === "number")
    out.push(`maxLength: ${schema.maxLength}`);
  if (typeof schema.minimum === "number") out.push(`min: ${schema.minimum}`);
  if (typeof schema.maximum === "number") out.push(`max: ${schema.maximum}`);
  if (typeof schema.exclusiveMinimum === "number")
    out.push(`> ${schema.exclusiveMinimum}`);
  if (typeof schema.exclusiveMaximum === "number")
    out.push(`< ${schema.exclusiveMaximum}`);
  if (typeof schema.minItems === "number")
    out.push(`minItems: ${schema.minItems}`);
  if (typeof schema.maxItems === "number")
    out.push(`maxItems: ${schema.maxItems}`);
  if (typeof schema.uniqueItems === "boolean" && schema.uniqueItems)
    out.push("unique");
  return out;
}

/** Read-only visualization of a JSON schema (shadcn Accordion + Badge tree). */
export function SchemaViewer({ schema }: { schema: JSONSchema }) {
  return (
    <div className="text-sm">
      <SchemaNode schema={schema} name={null} depth={0} />
    </div>
  );
}

function SchemaNode({
  schema,
  name,
  depth,
  required = false,
}: {
  schema: JSONSchema;
  name: string | null;
  depth: number;
  required?: boolean;
}) {
  const description =
    typeof schema.description === "string" ? schema.description : undefined;
  const title = typeof schema.title === "string" ? schema.title : undefined;

  const combinators: Array<{ key: string; branches: JSONSchema[] }> = [];
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      combinators.push({ key, branches: branches as JSONSchema[] });
    }
  }
  if (combinators.length > 0) {
    return (
      <div className={depth > 0 ? "border-l-2 pl-3" : ""}>
        <SchemaHeader
          name={name}
          type={combinators.map((c) => c.key).join(" / ")}
          required={required}
          title={title}
        />
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-1 space-y-2">
          {combinators.flatMap(({ key, branches }) =>
            branches.map((branch, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: schema branches have no stable identity
              <div key={`${key}-${i}`} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {key} variant {i + 1}
                  {typeof branch.title === "string" ? `: ${branch.title}` : ""}
                </p>
                <SchemaNode schema={branch} name={null} depth={depth + 1} />
              </div>
            )),
          )}
        </div>
      </div>
    );
  }

  const properties = schema.properties as
    | Record<string, JSONSchema>
    | undefined;
  if (schema.type === "object" || (properties && depth === 0)) {
    const requiredList = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    const entries = Object.entries(properties ?? {});
    if (depth === 0) {
      if (entries.length === 0) {
        return (
          <div>
            <SchemaHeader
              name={name}
              type="object"
              required={required}
              title={title}
            />
            {description ? (
              <p className="text-xs text-muted-foreground">{description}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              No properties defined.
            </p>
          </div>
        );
      }
      return (
        <div>
          <SchemaHeader
            name={name}
            type="object"
            required={required}
            title={title}
          />
          {description ? (
            <p className="mb-1 text-xs text-muted-foreground">{description}</p>
          ) : null}
          <Accordion type="multiple" defaultValue={[]}>
            {entries.map(([propName, propSchema]) => (
              <AccordionItem key={propName} value={propName}>
                <AccordionTrigger>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium">
                      {propName}
                    </span>
                    <Badge
                      variant="secondary"
                      className="font-mono text-[10px]"
                    >
                      {typeLabel(propSchema)}
                    </Badge>
                    {requiredList.includes(propName) ? (
                      <span className="text-xs text-destructive">required</span>
                    ) : null}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <SchemaNode
                    schema={propSchema}
                    name={null}
                    depth={depth + 1}
                    required={false}
                  />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      );
    }
    return (
      <div className="border-l-2 pl-3">
        <SchemaHeader
          name={name}
          type="object"
          required={required}
          title={title}
        />
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
        {entries.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            No properties defined.
          </p>
        ) : (
          <div className="mt-1 space-y-2">
            {entries.map(([propName, propSchema]) => (
              <SchemaNode
                key={propName}
                schema={propSchema}
                name={propName}
                depth={depth + 1}
                required={requiredList.includes(propName)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (schema.type === "array") {
    return (
      <div className={depth > 0 ? "border-l-2 pl-3" : ""}>
        <SchemaHeader
          name={name}
          type="array"
          required={required}
          title={title}
        />
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-1">
          <SchemaNode
            schema={(schema.items ?? {}) as JSONSchema}
            name="items"
            depth={depth + 1}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={depth > 0 ? "border-l-2 pl-3" : ""}>
      <SchemaHeader
        name={name}
        type={typeLabel(schema)}
        required={required}
        title={title}
      />
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
      {Array.isArray(schema.enum) ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {(schema.enum as unknown[]).map((option) => (
            <Badge
              key={String(option)}
              variant="outline"
              className="font-mono text-[10px]"
            >
              {String(option)}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-1">
        {constraintBadges(schema).map((c) => (
          <Badge key={c} variant="outline" className="font-mono text-[10px]">
            {c}
          </Badge>
        ))}
      </div>
      {schema.default !== undefined ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          default: {JSON.stringify(schema.default)}
        </p>
      ) : null}
      {typeof schema.const !== "undefined" ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          const: {JSON.stringify(schema.const)}
        </p>
      ) : null}
    </div>
  );
}

function SchemaHeader({
  name,
  type,
  required,
  title,
}: {
  name: string | null;
  type: string;
  required: boolean;
  title?: string;
}) {
  return (
    <p className="flex flex-wrap items-center gap-2">
      {name ? (
        <span className="font-mono text-xs font-medium">{name}</span>
      ) : null}
      {title ? <span className="text-xs font-medium">{title}</span> : null}
      <Badge variant="secondary" className="font-mono text-[10px]">
        {type}
      </Badge>
      {required ? (
        <span className="text-xs text-destructive">required</span>
      ) : null}
    </p>
  );
}
