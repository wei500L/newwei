package exec

import (
	"github.com/vektah/gqlparser/v2/ast"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func (e *Engine) operationSupported(doc *ast.QueryDocument, op *ast.OperationDefinition) bool {
	root := e.rootDefinition(op)
	if root == nil {
		return false
	}
	return e.selectionSupported(root, op.SelectionSet, doc, map[string]bool{})
}

// rootDefinition returns the SDL root object type for an operation, or nil for
// operation kinds the Go executor never runs (subscriptions).
func (e *Engine) rootDefinition(op *ast.OperationDefinition) *ast.Definition {
	if op == nil || e.schema == nil {
		return nil
	}
	switch op.Operation {
	case ast.Query:
		return e.schema.Query
	case ast.Mutation:
		return e.schema.Mutation
	default:
		return nil
	}
}

// rootResolver returns the registered resolver lookup for a root object type.
// A non-root definition has no lookup.
func (e *Engine) rootResolver(parent *ast.Definition) func(string) (contract.Root, bool) {
	switch {
	case parent == nil, e.schema != nil && parent == e.schema.Query:
		return e.reg.Query
	case e.schema != nil && e.schema.Mutation != nil && parent == e.schema.Mutation:
		return e.reg.Mutation
	default:
		return nil
	}
}

func (e *Engine) selectionSupported(parent *ast.Definition, set ast.SelectionSet, doc *ast.QueryDocument, stack map[string]bool) bool {
	lookup := e.rootResolver(parent)
	rootDef := parent
	if rootDef == nil {
		rootDef = e.schema.Query
	}
	for _, selection := range set {
		switch node := selection.(type) {
		case *ast.Field:
			if node.Name == "__typename" {
				continue
			}
			if lookup != nil {
				if rootDef == nil || rootDef.Fields.ForName(node.Name) == nil {
					continue
				}
				if _, ok := lookup(node.Name); !ok {
					return false
				}
				fieldDef := rootDef.Fields.ForName(node.Name)
				if !e.typeSupported(fieldDef.Type, node.SelectionSet, doc, stack) {
					return false
				}
				continue
			}
			if parent.Fields.ForName(node.Name) == nil {
				continue
			}
			if !e.reg.HasField(parent.Name, node.Name) {
				return false
			}
			if !e.typeSupported(parent.Fields.ForName(node.Name).Type, node.SelectionSet, doc, stack) {
				return false
			}
		case *ast.InlineFragment:
			next := parent
			if node.TypeCondition != "" {
				next = e.schema.Types[node.TypeCondition]
				if next != nil && !e.compositeRegistered(next) {
					return false
				}
			}
			if !e.selectionSupported(next, node.SelectionSet, doc, stack) {
				return false
			}
		case *ast.FragmentSpread:
			if stack[node.Name] {
				continue
			}
			frag := doc.Fragments.ForName(node.Name)
			if frag == nil {
				continue
			}
			stack[node.Name] = true
			next := e.schema.Types[frag.TypeCondition]
			if next != nil && !e.compositeRegistered(next) {
				return false
			}
			if !e.selectionSupported(next, frag.SelectionSet, doc, stack) {
				return false
			}
			delete(stack, node.Name)
		}
	}
	return true
}

func (e *Engine) compositeRegistered(def *ast.Definition) bool {
	if def == nil {
		return true
	}
	if def.Kind != ast.Object && def.Kind != ast.Interface && def.Kind != ast.Union {
		return true
	}
	if def == e.schema.Query || def == e.schema.Mutation || def.Name == "Query" || def.Name == "Mutation" {
		return true
	}
	return e.reg.HasType(def.Name)
}

func (e *Engine) typeSupported(typ *ast.Type, set ast.SelectionSet, doc *ast.QueryDocument, stack map[string]bool) bool {
	if typ == nil {
		return true
	}
	if typ.Elem != nil {
		return e.typeSupported(typ.Elem, set, doc, stack)
	}
	def := e.schema.Types[typ.Name()]
	if def == nil || def.Kind == ast.Scalar || def.Kind == ast.Enum {
		return true
	}
	if !e.compositeRegistered(def) {
		return false
	}
	return e.selectionSupported(def, set, doc, stack)
}

type collectedField struct {
	Key        string
	Name       string
	Field      *ast.Field
	Selections ast.SelectionSet
}

// buildFieldSet converts a resolved selection set into the read-only metadata a
// resolver receives. It reuses collectFields, so aliases collapse onto the
// canonical field name and fragments, @skip and @include are already applied
// exactly as they are for projection. A scalar field has an empty sub-set.
func buildFieldSet(schema *ast.Schema, parent *ast.Definition, set ast.SelectionSet, doc *ast.QueryDocument, vars map[string]any) *contract.FieldSet {
	out := contract.NewFieldSet()
	if parent == nil {
		return out
	}
	for _, field := range collectFields(schema, parent, set, doc, vars, map[string]bool{}) {
		if field.Name == "__typename" {
			continue
		}
		fieldDef := parent.Fields.ForName(field.Name)
		if fieldDef == nil {
			continue
		}
		child := schema.Types[fieldDef.Type.Name()]
		out.Set(field.Name, buildFieldSet(schema, child, field.Selections, doc, vars))
	}
	return out
}

func collectFields(schema *ast.Schema, parent *ast.Definition, set ast.SelectionSet, doc *ast.QueryDocument, vars map[string]any, stack map[string]bool) []collectedField {
	ordered := make([]collectedField, 0)
	index := map[string]int{}
	var walk func(parent *ast.Definition, set ast.SelectionSet)
	walk = func(parent *ast.Definition, set ast.SelectionSet) {
		for _, selection := range set {
			switch node := selection.(type) {
			case *ast.Field:
				if !includeSelection(node.Directives, vars) {
					continue
				}
				key := node.Alias
				if key == "" {
					key = node.Name
				}
				if pos, ok := index[key]; ok {
					ordered[pos].Selections = append(ordered[pos].Selections, node.SelectionSet...)
					continue
				}
				index[key] = len(ordered)
				ordered = append(ordered, collectedField{
					Key:        key,
					Name:       node.Name,
					Field:      node,
					Selections: append(ast.SelectionSet{}, node.SelectionSet...),
				})
			case *ast.InlineFragment:
				if !includeSelection(node.Directives, vars) {
					continue
				}
				next := parent
				if node.TypeCondition != "" {
					candidate := schema.Types[node.TypeCondition]
					if candidate == nil || !fragmentApplies(schema, parent, candidate) {
						continue
					}
					next = candidate
				}
				walk(next, node.SelectionSet)
			case *ast.FragmentSpread:
				if !includeSelection(node.Directives, vars) || stack[node.Name] {
					continue
				}
				frag := doc.Fragments.ForName(node.Name)
				if frag == nil {
					continue
				}
				candidate := schema.Types[frag.TypeCondition]
				if candidate == nil || !fragmentApplies(schema, parent, candidate) {
					continue
				}
				stack[node.Name] = true
				walk(candidate, frag.SelectionSet)
				delete(stack, node.Name)
			}
		}
	}
	walk(parent, set)
	return ordered
}

func fragmentApplies(schema *ast.Schema, parent, fragmentType *ast.Definition) bool {
	if parent == nil || fragmentType == nil {
		return false
	}
	if parent.Name == fragmentType.Name {
		return true
	}
	for _, name := range parent.Interfaces {
		if name == fragmentType.Name {
			return true
		}
	}
	if fragmentType.Kind == ast.Interface || fragmentType.Kind == ast.Union {
		for _, possible := range schema.PossibleTypes[fragmentType.Name] {
			if possible != nil && possible.Name == parent.Name {
				return true
			}
		}
	}
	return false
}

func includeSelection(directives ast.DirectiveList, vars map[string]any) bool {
	if directive := directives.ForName("skip"); directive != nil && directiveBool(directive, vars) {
		return false
	}
	if directive := directives.ForName("include"); directive != nil && !directiveBool(directive, vars) {
		return false
	}
	return true
}

func directiveBool(directive *ast.Directive, vars map[string]any) bool {
	args := directive.ArgumentMap(vars)
	value, ok := args["if"].(bool)
	return ok && value
}

func (e *Engine) depthErrors(doc *ast.QueryDocument) []graphError {
	if e.depthLimit <= 0 {
		return nil
	}
	var errors []graphError
	for _, op := range doc.Operations {
		for _, child := range op.SelectionSet {
			e.depthSelection(child, doc, 0, op.Name, map[string]bool{}, &errors)
		}
	}
	return errors
}

// depthSelection matches graphql-depth-limit: the operation and fragments do
// not add a level, each non-introspection field does, and __typename is ignored
// after the depth check. Anonymous operations use an empty name, so the
// message is "” exceeds maximum operation depth of N".
func (e *Engine) depthSelection(node ast.Selection, doc *ast.QueryDocument, depthSoFar int, operationName string, stack map[string]bool, errors *[]graphError) {
	if depthSoFar > e.depthLimit {
		pos := (*ast.Position)(nil)
		if field, ok := node.(*ast.Field); ok {
			pos = field.Position
		}
		*errors = append(*errors, graphError{
			Message:   "'" + operationName + "' exceeds maximum operation depth of " + itoa(e.depthLimit),
			Locations: positionLocations(pos),
		})
		return
	}
	switch typed := node.(type) {
	case *ast.Field:
		if isIntrospectionName(typed.Name) || len(typed.SelectionSet) == 0 {
			return
		}
		for _, child := range typed.SelectionSet {
			e.depthSelection(child, doc, depthSoFar+1, operationName, stack, errors)
		}
	case *ast.InlineFragment:
		for _, child := range typed.SelectionSet {
			e.depthSelection(child, doc, depthSoFar, operationName, stack, errors)
		}
	case *ast.FragmentSpread:
		if stack[typed.Name] {
			return
		}
		frag := doc.Fragments.ForName(typed.Name)
		if frag == nil {
			return
		}
		stack[typed.Name] = true
		for _, child := range frag.SelectionSet {
			e.depthSelection(child, doc, depthSoFar, operationName, stack, errors)
		}
		delete(stack, typed.Name)
	}
}

func isIntrospectionName(name string) bool {
	return len(name) >= 2 && name[0] == '_' && name[1] == '_'
}

func positionLocations(pos *ast.Position) []location {
	if pos == nil || pos.Line == 0 {
		return nil
	}
	return []location{{Line: pos.Line, Column: pos.Column}}
}

func (e *Engine) complexityOf(op *ast.OperationDefinition, doc *ast.QueryDocument, vars map[string]any) int {
	root := e.rootDefinition(op)
	if root == nil {
		return 0
	}
	return e.selectionComplexity(root, op.SelectionSet, doc, vars, map[string]bool{})
}

func (e *Engine) selectionComplexity(parent *ast.Definition, set ast.SelectionSet, doc *ast.QueryDocument, vars map[string]any, stack map[string]bool) int {
	total := 0
	for _, selection := range set {
		switch node := selection.(type) {
		case *ast.Field:
			if !includeSelection(node.Directives, vars) {
				continue
			}
			child := 0
			var fieldDef *ast.FieldDefinition
			if node.Name != "__typename" && parent != nil {
				fieldDef = parent.Fields.ForName(node.Name)
			}
			if fieldDef != nil && node.SelectionSet != nil {
				next := e.schema.Types[fieldDef.Type.Name()]
				child = e.selectionComplexity(next, node.SelectionSet, doc, vars, stack)
			}
			total += fieldCost(e.schema, fieldDef, node, vars, child)
		case *ast.InlineFragment:
			if !includeSelection(node.Directives, vars) {
				continue
			}
			next := parent
			if node.TypeCondition != "" && e.schema.Types[node.TypeCondition] != nil {
				next = e.schema.Types[node.TypeCondition]
			}
			total += e.selectionComplexity(next, node.SelectionSet, doc, vars, stack)
		case *ast.FragmentSpread:
			if !includeSelection(node.Directives, vars) || stack[node.Name] {
				continue
			}
			frag := doc.Fragments.ForName(node.Name)
			if frag == nil {
				continue
			}
			stack[node.Name] = true
			next := parent
			if e.schema.Types[frag.TypeCondition] != nil {
				next = e.schema.Types[frag.TypeCondition]
			}
			total += e.selectionComplexity(next, frag.SelectionSet, doc, vars, stack)
			delete(stack, node.Name)
		}
	}
	return total
}

func fieldCost(schema *ast.Schema, def *ast.FieldDefinition, field *ast.Field, vars map[string]any, child int) int {
	if def != nil {
		if directive := def.Directives.ForName("complexity"); directive != nil {
			if cost, ok := directiveCost(directive, field, vars, child); ok {
				return cost
			}
		}
	}
	args := map[string]any{}
	if field != nil && field.Definition != nil {
		args = field.ArgumentMap(vars)
	}
	if child > 0 {
		if page, ok := pageSize(args); ok {
			if page < 0 {
				page = 0
			}
			return 1 + child*page
		}
	}
	if def != nil && isCompositeField(schema, def) {
		return 2 + child
	}
	return 1
}

func directiveCost(directive *ast.Directive, field *ast.Field, vars map[string]any, child int) (int, bool) {
	args := directive.ArgumentMap(nil)
	if args == nil {
		return 0, false
	}
	value, ok := contract.AsInt(args["value"])
	if !ok {
		return 0, false
	}
	multiplier := 1
	if raw, exists := args["multipliers"]; exists {
		if names, ok := raw.([]any); ok {
			fieldArgs := map[string]any{}
			if field != nil && field.Definition != nil {
				fieldArgs = field.ArgumentMap(vars)
			}
			for _, name := range names {
				text, ok := name.(string)
				if !ok {
					continue
				}
				if number, ok := contract.AsInt(fieldArgs[text]); ok {
					multiplier *= number
					continue
				}
				if list, ok := fieldArgs[text].([]any); ok {
					multiplier *= len(list)
				}
			}
		}
	}
	return (value + child) * multiplier, true
}

func pageSize(args map[string]any) (int, bool) {
	for _, name := range []string{"first", "last", "take", "limit", "pageSize", "perPage"} {
		value, state := contract.Lookup(args, name)
		if state != contract.ArgValue {
			continue
		}
		if number, ok := contract.AsInt(value); ok {
			return number, true
		}
		if number, ok := contract.AsFloat(value); ok && number == float64(int(number)) {
			return int(number), true
		}
	}
	return 0, false
}

func isCompositeField(schema *ast.Schema, def *ast.FieldDefinition) bool {
	if def == nil || def.Type == nil {
		return false
	}
	named := schema.Types[def.Type.Name()]
	if named == nil {
		return false
	}
	return named.Kind == ast.Object || named.Kind == ast.Interface || named.Kind == ast.Union
}

func directRootNames(op *ast.OperationDefinition) []string {
	if op == nil {
		return nil
	}
	names := make([]string, 0)
	for _, selection := range op.SelectionSet {
		field, ok := selection.(*ast.Field)
		if !ok || field.Name == "__typename" {
			continue
		}
		names = append(names, field.Name)
	}
	return names
}
