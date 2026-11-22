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

  procedure get_names_and_values(a_json clob, a_names out nocopy ut_varchar2_list, a_values out nocopy ut_varchar2_list) is
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

  function get_test_case_description(a_description varchar2, a_json clob) return varchar2 is
    l_names  ut_varchar2_list;
    l_values ut_varchar2_list;
  begin
    get_names_and_values(a_json, l_names, l_values);
    return ut_utils.get_test_case_description(
      a_description, l_names, l_values,
      dbms_lob.substr(ut_utils.table_to_clob(l_values, ', '), ut_utils.gc_max_storage_varchar2_len)
    );
  end;

  function get_call(a_owner varchar2, a_package varchar2, a_procedure varchar2, a_call_name varchar2, a_json clob) return varchar2 is
    l_all_parameters ut_metadata.tt_parameters :=
      ut_metadata.get_package_parameters(upper(a_owner), upper(a_package), upper(a_procedure));
    l_parameters     ut_metadata.tt_parameters := ut_metadata.tt_parameters();
    l_element        json_element_t := json_element_t.parse(a_json);
    l_array          json_array_t;
    l_keys           json_key_list;
    l_case_type      varchar2(30 char);
    l_uses_case      boolean := false;
    l_count          binary_integer := 0;
    l_declarations   varchar2(32767);
    l_selects        varchar2(32767);
    l_intos          varchar2(32767);
    l_assignments    varchar2(32767);
    l_arguments      varchar2(32767);
    l_given          ut_varchar2_list := ut_varchar2_list();

    procedure add_argument(a_parameter ut_metadata.t_parameter, a_path varchar2, a_accessor varchar2) is
      l_variable    varchar2(30 char);
      l_type        varchar2(128 char) := a_parameter.data_type;
      l_declaration varchar2(400 char);
      l_returning   varchar2(400 char);
      l_expression  varchar2(4000 char);
    begin
      l_count := l_count + 1;
      l_variable := 'l_ut_arg_' || l_count;
      if l_type in ('BOOLEAN', 'PL/SQL BOOLEAN') then
        -- SQL has no BOOLEAN before Oracle 23, so it is read with the PL/SQL JSON API
        l_declaration := 'boolean';
        l_uses_case := true;
        l_assignments := l_assignments || '  ' || l_variable || ' := case when l_ut_case.get(' || a_accessor || ').is_null then null'
          || ' else l_ut_case.get_boolean(' || a_accessor || ') end;' || chr(10);
      else
        case
          when l_type in ('NUMBER', 'FLOAT', 'BINARY_INTEGER') then
            l_declaration := 'number';
            l_returning := 'number';
          when l_type in ('BINARY_FLOAT', 'BINARY_DOUBLE') then
            l_declaration := lower(l_type);
            l_returning := 'number';
          when l_type in ('VARCHAR2', 'CHAR') then
            l_declaration := 'varchar2(32767)';
            l_returning := 'clob';
          when l_type in ('NVARCHAR2', 'NCHAR') then
            l_declaration := 'nvarchar2(32767)';
            l_returning := 'clob';
          when l_type in ('CLOB', 'NCLOB') then
            l_declaration := lower(l_type);
            l_returning := 'clob';
          when l_type = 'DATE' then
            -- returning date drops the time
            l_declaration := 'date';
            l_returning := 'timestamp';
          when l_type = 'TIMESTAMP' then
            l_declaration := 'timestamp(9)';
            l_returning := 'timestamp';
          when l_type in ('TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE') then
            l_declaration := replace(lower(l_type), 'timestamp', 'timestamp(9)');
            l_returning := 'timestamp with time zone';
          when l_type = 'INTERVAL DAY TO SECOND' then
            l_declaration := 'interval day(9) to second(9)';
            l_expression := 'to_dsinterval(json_value(l_ut_json, ''' || a_path || ''' returning varchar2(100) error on error))';
          when l_type = 'INTERVAL YEAR TO MONTH' then
            l_declaration := 'interval year(9) to month';
            l_expression := 'to_yminterval(json_value(l_ut_json, ''' || a_path || ''' returning varchar2(100) error on error))';
          when l_type = 'RAW' then
            l_declaration := 'raw(32767)';
            l_expression := 'hextoraw(json_value(l_ut_json, ''' || a_path || ''' returning varchar2(4000) error on error))';
          when l_type in ('OBJECT', 'TABLE', 'VARRAY') and a_parameter.type_subname is null
            and a_parameter.type_owner not in ('SYS', 'PUBLIC') then
            l_declaration := '"' || a_parameter.type_owner || '"."' || a_parameter.type_name || '"';
            -- error on mismatch: a missing or misspelled attribute is an error instead of a null attribute
            l_expression := 'json_value(l_ut_json, ''' || a_path || ''' returning ' || l_declaration || ' error on error error on mismatch)';
          else
            raise_invalid(
              'parameter ' || a_parameter.parameter_name || ' has a data type that can''t be passed from JSON: '
              || nvl(a_parameter.type_name, l_type)
            );
        end case;
        l_expression := nvl(l_expression, 'json_value(l_ut_json, ''' || a_path || ''' returning ' || l_returning || ' error on error)');
        l_selects := l_selects || case when l_selects is not null then ',' || chr(10) || '         ' end || l_expression;
        l_intos := l_intos || case when l_intos is not null then ', ' end || l_variable;
      end if;
      l_declarations := l_declarations || '  ' || l_variable || ' ' || l_declaration || ';' || chr(10);
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
        add_argument(l_parameters(i + 1), '$[' || i || ']', to_char(i));
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
        -- the key matches a parameter name, so it can be used in a JSON path and a string literal as it is
        add_argument(find_parameter(l_keys(i)), '$."' || l_keys(i) || '"', '''' || l_keys(i) || '''');
      end loop;
    else
      raise_invalid('it must be a JSON array or a JSON object');
    end if;

    return
      'declare' || chr(10) ||
      '  l_ut_json clob := :ut_json;' || chr(10) ||
      case when l_uses_case then '  l_ut_case ' || l_case_type || ' := ' || l_case_type || '.parse(l_ut_json);' || chr(10) end ||
      l_declarations ||
      'begin' || chr(10) ||
      case when l_uses_case then '  l_ut_case.on_error(1);' || chr(10) end ||
      case when l_selects is not null then '  select ' || l_selects || chr(10) || '    into ' || l_intos || ' from dual;' || chr(10) end ||
      l_assignments ||
      '  ' || a_call_name || case when l_arguments is not null then '(' || l_arguments || ')' end || ';' || chr(10) ||
      'end;';
  end;

end;
/
