create or replace noneditionable package body ut_test_case_json as
  /*
  utPLSQL - Version 3
  Copyright 2016 - 2026 utPLSQL Project

  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
  */

  procedure raise_invalid(a_message varchar2) is
  begin
    raise_application_error(ut_utils.gc_invalid_test_case_source, 'Invalid JSON test case: ' || a_message || '.');
  end;

  function is_json(a_arguments varchar2) return boolean is
  begin
    return substr(ltrim(a_arguments, ' ' || chr(9) || chr(10) || chr(13)), 1, 1) in ('[', '{');
  end;

  function get_json_error(a_json clob) return varchar2 is
    l_element json_element_t;
  begin
    l_element := json_element_t.parse(a_json);
    return case when not (l_element.is_array or l_element.is_object) then 'it must be a JSON array or a JSON object' end;
  exception
    when others then
      return 'it is not valid JSON';
  end;

  procedure get_names_and_values(
    a_json clob, a_names out nocopy ut_varchar2_list, a_values out nocopy ut_varchar2_list, a_parameter_names ut_varchar2_list := null
  ) is
    l_element json_element_t := json_element_t.parse(a_json);
    l_array   json_array_t;
    l_object  json_object_t;
    l_keys    json_key_list;

    function display_value(a_value json_element_t, a_string varchar2) return varchar2 is
    begin
      return substr(
        case when a_value.is_string then a_string when a_value.is_null then 'null' else a_value.to_string end,
        1, ut_utils.gc_max_storage_varchar2_len
      );
    end;
  begin
    a_names := ut_varchar2_list();
    a_values := ut_varchar2_list();
    if l_element.is_array then
      l_array := treat(l_element as json_array_t);
      for i in 0 .. l_array.get_size - 1 loop
        a_names.extend;
        -- values passed by position get the name of their parameter, so the description can refer to them by name
        if i < cardinality(a_parameter_names) then
          a_names(a_names.last) := lower(a_parameter_names(i + 1));
        end if;
        a_values.extend;
        a_values(a_values.last) := display_value(l_array.get(i), case when l_array.get(i).is_string then l_array.get_string(i) end);
      end loop;
    elsif l_element.is_object then
      l_object := treat(l_element as json_object_t);
      l_keys := l_object.get_keys;
      for i in 1 .. l_keys.count loop
        a_names.extend;
        a_names(a_names.last) := l_keys(i);
        a_values.extend;
        a_values(a_values.last) := display_value(
          l_object.get(l_keys(i)), case when l_object.get(l_keys(i)).is_string then l_object.get_string(l_keys(i)) end
        );
      end loop;
    end if;
  end;

  function get_arguments_text(a_json clob) return varchar2 is
    l_names  ut_varchar2_list;
    l_values ut_varchar2_list;
    l_result varchar2(32767);
  begin
    get_names_and_values(a_json, l_names, l_values);
    for i in 1 .. l_names.count loop
      l_result := l_result || case when i > 1 then ', ' end || case when l_names(i) is not null then l_names(i) || ' => ' end || 'null';
    end loop;
    return l_result;
  end;

  function get_test_case_description(
    a_description varchar2, a_json clob, a_parameter_names ut_varchar2_list := null
  ) return varchar2 is
    l_names  ut_varchar2_list;
    l_values ut_varchar2_list;
  begin
    get_names_and_values(a_json, l_names, l_values, a_parameter_names);
    return ut_utils.get_test_case_description(
      a_description, l_names, l_values,
      dbms_lob.substr(ut_utils.table_to_clob(l_values, ', '), ut_utils.gc_max_storage_varchar2_len)
    );
  end;

  function get_call(a_owner varchar2, a_package varchar2, a_procedure varchar2, a_call_name varchar2, a_json clob) return varchar2 is
    type tt_names is table of varchar2(30 char) index by varchar2(400 char);
    l_all_parameters ut_metadata.tt_parameters :=
      ut_metadata.get_package_parameters(upper(a_owner), upper(a_package), upper(a_procedure));
    l_parameters     ut_metadata.tt_parameters := ut_metadata.tt_parameters();
    l_element        json_element_t := json_element_t.parse(a_json);
    l_array          json_array_t;
    l_keys           json_key_list;
    l_case_type      varchar2(30 char);
    l_count          binary_integer := 0;
    l_declarations   varchar2(32767);
    l_functions      varchar2(32767);
    l_assignments    varchar2(32767);
    l_arguments      varchar2(32767);
    l_given          ut_varchar2_list := ut_varchar2_list();
    -- each type is converted by one generated function, named by type
    l_converters     tt_names;
    c_error          constant varchar2(30 char) := to_char(ut_utils.gc_invalid_test_case_source);

    function quoted_name(a_owner varchar2, a_package varchar2, a_name varchar2) return varchar2 is
    begin
      return '"' || a_owner || '"."' || case when a_package is not null then a_package || '"."' end || a_name || '"';
    end;

    -- declaration and SQL expression for a value of a built-in or SQL type, read with json_value from a_document at a_path
    procedure get_sql_conversion(
      a_builtin_type varchar2, a_type_owner varchar2, a_type_name varchar2, a_document varchar2, a_path varchar2,
      a_declaration out varchar2, a_expression out varchar2
    ) is
      l_returning varchar2(400 char);
      l_value     varchar2(400 char) := 'json_value(' || a_document || ', ''' || a_path || ''' returning ';
    begin
      if a_builtin_type is null then
        if a_type_owner = 'PUBLIC' or a_type_owner = 'SYS' and a_type_name in ('XMLTYPE', 'ANYDATA', 'ANYTYPE', 'ANYDATASET') then
          return;
        end if;
        a_declaration := quoted_name(a_type_owner, null, a_type_name);
        -- error on mismatch: a missing or misspelled attribute is an error instead of a null attribute
        a_expression := l_value || a_declaration || ' error on error error on mismatch)';
        return;
      end if;
      case
        when a_builtin_type in ('NUMBER', 'FLOAT', 'INTEGER', 'BINARY_INTEGER', 'PLS_INTEGER', 'PL/SQL PLS INTEGER', 'PL/SQL BINARY INTEGER') then
          a_declaration := 'number';
          l_returning := 'number';
        when a_builtin_type in ('BINARY_FLOAT', 'BINARY_DOUBLE') then
          a_declaration := lower(a_builtin_type);
          l_returning := 'number';
        when a_builtin_type in ('VARCHAR2', 'VARCHAR', 'CHAR', 'STRING') then
          a_declaration := 'varchar2(32767)';
          l_returning := 'clob';
        when a_builtin_type in ('NVARCHAR2', 'NCHAR') then
          a_declaration := 'nvarchar2(32767)';
          l_returning := 'clob';
        when a_builtin_type in ('CLOB', 'NCLOB') then
          a_declaration := lower(a_builtin_type);
          l_returning := 'clob';
        when a_builtin_type = 'DATE' then
          -- returning date drops the time
          a_declaration := 'date';
          l_returning := 'timestamp';
        when a_builtin_type = 'TIMESTAMP' then
          a_declaration := 'timestamp(9)';
          l_returning := 'timestamp';
        when a_builtin_type in ('TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE') then
          a_declaration := replace(lower(a_builtin_type), 'timestamp', 'timestamp(9)');
          l_returning := 'timestamp with time zone';
        when a_builtin_type = 'INTERVAL DAY TO SECOND' then
          a_declaration := 'interval day(9) to second(9)';
          a_expression := 'to_dsinterval(' || l_value || 'varchar2(100) error on error))';
        when a_builtin_type = 'INTERVAL YEAR TO MONTH' then
          a_declaration := 'interval year(9) to month';
          a_expression := 'to_yminterval(' || l_value || 'varchar2(100) error on error))';
        when a_builtin_type = 'RAW' then
          a_declaration := 'raw(32767)';
          a_expression := 'hextoraw(' || l_value || 'varchar2(4000) error on error))';
        else
          return;
      end case;
      a_expression := nvl(a_expression, l_value || l_returning || ' error on error)');
    end;

    -- a call of the generated function that converts a JSON element (a_value, an expression of type json_element_t) to the given type;
    -- a_type_package is set for PL/SQL types, a_type_owner for SQL types, a_builtin_type for built-in types
    function convert(
      a_builtin_type varchar2, a_type_owner varchar2, a_type_package varchar2, a_type_name varchar2, a_value varchar2, a_what varchar2
    ) return varchar2 is
      l_key         varchar2(400 char) := nvl(a_builtin_type, a_type_owner || '.' || a_type_package || '.' || a_type_name);
      l_function    varchar2(30 char);
      l_declaration varchar2(400 char);
      l_expression  varchar2(4000 char);
      l_code        varchar2(32767);
      l_typecode    varchar2(128 char);
      l_coll_type   varchar2(128 char);
      l_index_by    varchar2(128 char);
      l_elem_owner  varchar2(128 char);
      l_elem_name   varchar2(128 char);
      l_elem_pkg    varchar2(128 char);

      procedure raise_unsupported is
      begin
        raise_invalid(
          a_what || ' has a data type that can''t be passed from JSON: '
          || case when a_type_package is not null then a_type_package || '.' end || nvl(a_type_name, a_builtin_type)
        );
      end;
    begin
      if not l_converters.exists(l_key) then
        l_function := 'ut_convert_' || (l_converters.count + 1);
        l_converters(l_key) := l_function;
        if a_builtin_type in ('BOOLEAN', 'PL/SQL BOOLEAN') then
          l_code :=
            '  function ' || l_function || '(a_value json_element_t) return boolean is' || chr(10) ||
            '  begin' || chr(10) ||
            '    if a_value is null or a_value.is_null then' || chr(10) ||
            '      return null;' || chr(10) ||
            '    elsif a_value.is_true then' || chr(10) ||
            '      return true;' || chr(10) ||
            '    elsif a_value.is_false then' || chr(10) ||
            '      return false;' || chr(10) ||
            '    end if;' || chr(10) ||
            '    raise_application_error(' || c_error || ', ''Invalid JSON test case: true or false expected instead of '' || a_value.to_string || ''.'');' || chr(10) ||
            '  end;' || chr(10);
        elsif a_type_package is null then
          get_sql_conversion(a_builtin_type, a_type_owner, a_type_name, 'l_json', '$[0]', l_declaration, l_expression);
          if l_declaration is null then
            raise_unsupported();
          end if;
          l_code :=
            '  function ' || l_function || '(a_value json_element_t) return '
              || regexp_replace(l_declaration, '\([0-9]+\)') || ' is' || chr(10) ||
            '    l_array  json_array_t := json_array_t();' || chr(10) ||
            '    l_json   clob;' || chr(10) ||
            '    l_result ' || l_declaration || ';' || chr(10) ||
            '  begin' || chr(10) ||
            '    if a_value is null or a_value.is_null then' || chr(10) ||
            '      return null;' || chr(10) ||
            '    end if;' || chr(10) ||
            '    -- json_value reads from a document, so the value is wrapped in an array' || chr(10) ||
            '    l_array.append(a_value);' || chr(10) ||
            '    l_json := l_array.to_clob;' || chr(10) ||
            '    select ' || l_expression || ' into l_result from dual;' || chr(10) ||
            '    return l_result;' || chr(10) ||
            '  end;' || chr(10);
        else
          l_declaration := quoted_name(a_type_owner, a_type_package, a_type_name);
          begin
            select /*+ no_parallel */ typecode into l_typecode
              from all_plsql_types
             where owner = a_type_owner and package_name = a_type_package and type_name = a_type_name;
          exception
            when no_data_found then
              raise_unsupported();
          end;
          if l_typecode = 'PL/SQL RECORD' then
            -- a JSON object whose keys are field names; fields without key keep their default
            for r in (
              select /*+ no_parallel */ attr_name, attr_type_owner, attr_type_name, attr_type_package
                from all_plsql_type_attrs
               where owner = a_type_owner and package_name = a_type_package and type_name = a_type_name
               order by attr_no
            ) loop
              l_expression := l_expression ||
                '        when ''' || r.attr_name || ''' then' || chr(10) ||
                '          l_result."' || r.attr_name || '" := ' ||
                convert(
                  case when r.attr_type_owner is null then r.attr_type_name end, r.attr_type_owner, r.attr_type_package,
                  r.attr_type_name, 'l_object.get(l_keys(i))', 'field ' || r.attr_name || ' of ' || a_type_package || '.' || a_type_name
                ) || ';' || chr(10);
            end loop;
            l_code :=
              '  function ' || l_function || '(a_value json_element_t) return ' || l_declaration || ' is' || chr(10) ||
              '    l_result ' || l_declaration || ';' || chr(10) ||
              '    l_object json_object_t;' || chr(10) ||
              '    l_keys   json_key_list;' || chr(10) ||
              '  begin' || chr(10) ||
              '    if a_value is null or a_value.is_null then' || chr(10) ||
              '      return l_result;' || chr(10) ||
              '    elsif not a_value.is_object then' || chr(10) ||
              '      raise_application_error(' || c_error || ', ''Invalid JSON test case: a JSON object is expected for '
                || a_type_package || '.' || a_type_name || ' instead of '' || a_value.to_string || ''.'');' || chr(10) ||
              '    end if;' || chr(10) ||
              '    l_object := treat(a_value as json_object_t);' || chr(10) ||
              '    l_keys := l_object.get_keys;' || chr(10) ||
              '    for i in 1 .. l_keys.count loop' || chr(10) ||
              '      case upper(l_keys(i))' || chr(10) ||
              l_expression ||
              '        else' || chr(10) ||
              '          raise_application_error(' || c_error || ', ''Invalid JSON test case: '
                || a_type_package || '.' || a_type_name || ' has no field '' || l_keys(i) || ''.'');' || chr(10) ||
              '      end case;' || chr(10) ||
              '    end loop;' || chr(10) ||
              '    return l_result;' || chr(10) ||
              '  end;' || chr(10);
          else
            select /*+ no_parallel */ coll_type, index_by, elem_type_owner, elem_type_name, elem_type_package
              into l_coll_type, l_index_by, l_elem_owner, l_elem_name, l_elem_pkg
              from all_plsql_coll_types
             where owner = a_type_owner and package_name = a_type_package and type_name = a_type_name;
            l_expression := convert(
              case when l_elem_owner is null then l_elem_name end, l_elem_owner, l_elem_pkg, l_elem_name,
              'l_element', 'an element of ' || a_type_package || '.' || a_type_name
            );
            l_code :=
              '  function ' || l_function || '(a_value json_element_t) return ' || l_declaration || ' is' || chr(10) ||
              '    l_result  ' || l_declaration || ';' || chr(10) ||
              '    l_array   json_array_t;' || chr(10) ||
              '    l_object  json_object_t;' || chr(10) ||
              '    l_keys    json_key_list;' || chr(10) ||
              '    l_element json_element_t;' || chr(10) ||
              '  begin' || chr(10) ||
              '    if a_value is null or a_value.is_null then' || chr(10) ||
              '      return l_result;' || chr(10) ||
              '    end if;' || chr(10) ||
              case
                when l_coll_type = 'PL/SQL INDEX TABLE' and l_index_by in ('VARCHAR2', 'VARCHAR', 'STRING', 'LONG') then
                  -- indexed by string: a JSON object, its keys are the indexes
                  '    if not a_value.is_object then' || chr(10) ||
                  '      raise_application_error(' || c_error || ', ''Invalid JSON test case: a JSON object is expected for '
                    || a_type_package || '.' || a_type_name || ' instead of '' || a_value.to_string || ''.'');' || chr(10) ||
                  '    end if;' || chr(10) ||
                  '    l_object := treat(a_value as json_object_t);' || chr(10) ||
                  '    l_keys := l_object.get_keys;' || chr(10) ||
                  '    for i in 1 .. l_keys.count loop' || chr(10) ||
                  '      l_element := l_object.get(l_keys(i));' || chr(10) ||
                  '      l_result(l_keys(i)) := ' || l_expression || ';' || chr(10) ||
                  '    end loop;' || chr(10)
                when l_coll_type = 'PL/SQL INDEX TABLE' then
                  -- indexed by integer: a JSON array (indexes 1, 2, ...) or a JSON object with numeric keys (sparse indexes)
                  '    if a_value.is_object then' || chr(10) ||
                  '      l_object := treat(a_value as json_object_t);' || chr(10) ||
                  '      l_keys := l_object.get_keys;' || chr(10) ||
                  '      for i in 1 .. l_keys.count loop' || chr(10) ||
                  '        l_element := l_object.get(l_keys(i));' || chr(10) ||
                  '        l_result(to_number(l_keys(i))) := ' || l_expression || ';' || chr(10) ||
                  '      end loop;' || chr(10) ||
                  '    elsif a_value.is_array then' || chr(10) ||
                  '      l_array := treat(a_value as json_array_t);' || chr(10) ||
                  '      for i in 0 .. l_array.get_size - 1 loop' || chr(10) ||
                  '        l_element := l_array.get(i);' || chr(10) ||
                  '        l_result(i + 1) := ' || l_expression || ';' || chr(10) ||
                  '      end loop;' || chr(10) ||
                  '    else' || chr(10) ||
                  '      raise_application_error(' || c_error || ', ''Invalid JSON test case: a JSON array or object is expected for '
                    || a_type_package || '.' || a_type_name || ' instead of '' || a_value.to_string || ''.'');' || chr(10) ||
                  '    end if;' || chr(10)
                else
                  -- nested table or varray: a JSON array
                  '    if not a_value.is_array then' || chr(10) ||
                  '      raise_application_error(' || c_error || ', ''Invalid JSON test case: a JSON array is expected for '
                    || a_type_package || '.' || a_type_name || ' instead of '' || a_value.to_string || ''.'');' || chr(10) ||
                  '    end if;' || chr(10) ||
                  '    l_array := treat(a_value as json_array_t);' || chr(10) ||
                  '    l_result := ' || l_declaration || '();' || chr(10) ||
                  '    l_result.extend(l_array.get_size);' || chr(10) ||
                  '    for i in 0 .. l_array.get_size - 1 loop' || chr(10) ||
                  '      l_element := l_array.get(i);' || chr(10) ||
                  '      l_result(i + 1) := ' || l_expression || ';' || chr(10) ||
                  '    end loop;' || chr(10)
              end ||
              '    return l_result;' || chr(10) ||
              '  end;' || chr(10);
          end if;
        end if;
        -- functions of nested types are generated first, so each function is declared before it is called
        l_functions := l_functions || l_code;
      end if;
      return l_converters(l_key) || '(' || a_value || ')';
    end;

    procedure add_argument(a_parameter ut_metadata.t_parameter, a_accessor varchar2) is
      l_variable    varchar2(30 char);
      l_declaration varchar2(400 char);
      l_expression  varchar2(4000 char);
      l_type        varchar2(128 char) := a_parameter.data_type;
      l_what        varchar2(200 char) := 'parameter ' || a_parameter.parameter_name;
    begin
      l_count := l_count + 1;
      l_variable := 'l_ut_arg_' || l_count;
      if a_parameter.type_subname is not null then
        -- a type declared in a package
        l_declaration := quoted_name(a_parameter.type_owner, a_parameter.type_name, a_parameter.type_subname);
        l_expression := convert(null, a_parameter.type_owner, a_parameter.type_name, a_parameter.type_subname, 'l_ut_case.get(' || a_accessor || ')', l_what);
      elsif l_type in ('OBJECT', 'TABLE', 'VARRAY') and a_parameter.type_owner != 'PUBLIC' then
        l_declaration := quoted_name(a_parameter.type_owner, null, a_parameter.type_name);
        l_expression := convert(null, a_parameter.type_owner, null, a_parameter.type_name, 'l_ut_case.get(' || a_accessor || ')', l_what);
      else
        if l_type in ('BOOLEAN', 'PL/SQL BOOLEAN') then
          l_declaration := 'boolean';
        else
          get_sql_conversion(l_type, null, null, 'x', 'x', l_declaration, l_expression);
          if l_declaration is null then
            raise_invalid(l_what || ' has a data type that can''t be passed from JSON: ' || nvl(a_parameter.type_name, l_type));
          end if;
        end if;
        l_expression := convert(l_type, null, null, null, 'l_ut_case.get(' || a_accessor || ')', l_what);
      end if;
      l_declarations := l_declarations || '  ' || l_variable || ' ' || l_declaration || ';' || chr(10);
      l_assignments := l_assignments || '  ' || l_variable || ' := ' || l_expression || ';' || chr(10);
      l_arguments := l_arguments || case when l_arguments is not null then ', ' end || '"' || a_parameter.parameter_name || '" => ' || l_variable;
    end;

    function find_parameter(a_key varchar2) return ut_metadata.t_parameter is
    begin
      for i in 1 .. l_parameters.count loop
        if l_parameters(i).parameter_name = upper(a_key) then
          return l_parameters(i);
        end if;
      end loop;
      raise_invalid('the procedure has no parameter ' || a_key);
    end;
  begin
    for i in 1 .. l_all_parameters.count loop
      if l_all_parameters(i).overload != l_all_parameters(1).overload then
        raise_invalid('JSON test cases can''t be used with the overloaded procedure ' || upper(a_procedure));
      end if;
      if l_all_parameters(i).parameter_name is not null then
        l_parameters.extend;
        l_parameters(l_parameters.last) := l_all_parameters(i);
      end if;
    end loop;

    if l_element.is_array then
      l_case_type := 'json_array_t';
      l_array := treat(l_element as json_array_t);
      if l_array.get_size > l_parameters.count then
        raise_invalid(l_array.get_size || ' value(s) given, but the procedure has ' || l_parameters.count || ' parameter(s)');
      end if;
      for i in 0 .. l_array.get_size - 1 loop
        add_argument(l_parameters(i + 1), to_char(i));
      end loop;
    elsif l_element.is_object then
      l_case_type := 'json_object_t';
      l_keys := treat(l_element as json_object_t).get_keys;
      for i in 1 .. l_keys.count loop
        if upper(l_keys(i)) member of l_given then
          raise_invalid('parameter ' || upper(l_keys(i)) || ' is given twice');
        end if;
        l_given.extend;
        l_given(l_given.last) := upper(l_keys(i));
        -- the key matches a parameter name, so it can be used in a string literal as it is
        add_argument(find_parameter(l_keys(i)), '''' || l_keys(i) || '''');
      end loop;
    else
      raise_invalid('it must be a JSON array or a JSON object');
    end if;

    return
      'declare' || chr(10) ||
      '  l_ut_case ' || l_case_type || ' := ' || l_case_type || '.parse(:ut_json);' || chr(10) ||
      l_declarations ||
      l_functions ||
      'begin' || chr(10) ||
      l_assignments ||
      '  ' || a_call_name || case when l_arguments is not null then '(' || l_arguments || ')' end || ';' || chr(10) ||
      'end;';
  end;

end;
/
